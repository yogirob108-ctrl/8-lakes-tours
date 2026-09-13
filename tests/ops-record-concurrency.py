"""Local PostgreSQL only: run with python3 tests/ops-record-concurrency.py.
Uses two independent psql connections, polling pg_stat_activity for lock waits.
"""
import json
import os
import subprocess
import time

DSN = os.environ.get('OPS_TEST_DATABASE_URL', 'postgresql://localhost:55432/8l_test')
assert DSN.startswith(('postgresql://localhost:', 'postgresql://127.0.0.1:')), 'local DB only'
PREFIX = "set request.jwt.claim.role='service_role'; "
def sql(text):
    result = subprocess.run(['psql', DSN, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', PREFIX + text], text=True, capture_output=True)
    if result.returncode: raise AssertionError(result.stderr)
    return (result.stdout.strip().splitlines() or [''])[-1]
def lit(value): return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"

bid = sql("insert into customers(first_name,last_name,email) values ('Concurrency','Test','ops-concurrency@example.invalid') returning id")
try:
    project = sql("select id from tour_projects where slug='8-lakes-tours'")
    booking = sql(f"insert into bookings(public_reference,project_id,customer_id,tour_date,guest_count) values ('OPS-CONCURRENCY','{project}','{bid}','TBC',2) returning id")
    def snapshot(): return json.loads(sql(f"select ops_booking_snapshot('{project}','OPS-CONCURRENCY')"))
    snap = snapshot()
    patch = {'tour_date':'TBC','guest_count':2,'status':'application_received','riding_experience':None,'dietary_notes':None,'notes':'edited','total_trip_value_usd':1999,'online_due_usd':999,'online_paid_usd':0,'family_cash_due_usd':1000}
    customer = {k:snap['customer'][k] for k in ['first_name','last_name','email','phone','whatsapp','nationality','emergency_contact','notes']}
    travellers = [{'position':1,'is_lead':True,'first_name':'Concurrency','last_name':'Test','email':customer['email']}]
    def update(token):
        return f"select update_ops_booking_record('{project}','OPS-CONCURRENCY','{token}',{lit(patch)},{lit(customer)},{lit(travellers)},'Record updated','test')"
    # Payment/status/lease writer holds the row; stale Ops must wait then reject.
    for change in ["online_paid_usd=321", "status='confirmed'", "payment_confirmation_token='payment-worker',payment_confirmation_claimed_at=now()"]:
        token = snapshot()['revision']
        writer = subprocess.Popen(['psql',DSN,'-XAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        writer.stdin.write(f"begin; update bookings set {change} where id='{booking}'; select pg_sleep(1); commit;\n"); writer.stdin.close()
        time.sleep(.15)
        contender = subprocess.Popen(['psql',DSN,'-XAt','-v','ON_ERROR_STOP=1','-c',PREFIX+update(token)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        blocked = False
        for _ in range(30):
            if sql("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%update_ops_booking_record%'") != '0': blocked=True; break
            time.sleep(.02)
        if not blocked:
            out, err = contender.communicate()
            raise AssertionError(f'real concurrent Ops call must block on booking lock: {out} {err}')
        writer.wait(); out, err = contender.communicate()
        assert contender.returncode != 0 and 'stale booking record' in err, (out,err)
        assert snapshot()['booking']['notes'] is None
    assert snapshot()['booking']['online_paid_usd'] == 321
    assert snapshot()['booking']['status'] == 'confirmed'
    assert snapshot()['booking']['payment_confirmation_token'] == 'payment-worker'
    # Commercial edits now fence every active confirmation lease, not only cancellation.
    sql(f"update bookings set payment_confirmation_claimed_at=now()-interval '6 minutes' where id='{booking}'")
    # Force the LAST transactional statement to fail, proving no compensation writes.
    sql("create function public.ops_test_fail_audit() returns trigger language plpgsql as $$begin if new.title='Record updated' then raise exception 'audit fault'; end if; return new; end$$; create trigger ops_test_fail before insert on booking_events for each row execute function ops_test_fail_audit()")
    snap = snapshot()
    try: sql(update(snap['revision'])); raise AssertionError('expected failure')
    except AssertionError as error: assert 'audit fault' in str(error)
    assert snapshot() == snap, 'audit fault must roll back booking/customer/travellers together'
    sql("create or replace function public.ops_test_fail_audit() returns trigger language plpgsql as $$begin if new.title='Record updated' then perform pg_sleep(1); raise exception 'audit fault'; end if; return new; end$$")
    failing_ops = subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',PREFIX+update(snap['revision'])],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    for _ in range(50):
        if sql("select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%update_ops_booking_record%'") != '0': break
        time.sleep(.02)
    else: raise AssertionError('Ops did not reach injected audit fault')
    payment_writer = subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',f"update bookings set online_paid_usd=654,status='confirmed',payment_confirmation_token='new-worker' where id='{booking}'"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    for _ in range(30):
        if sql("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%new-worker%'") != '0': break
        time.sleep(.02)
    else: raise AssertionError('concurrent payment writer did not block behind Ops')
    _, error = failing_ops.communicate(); assert 'audit fault' in error
    _, error = payment_writer.communicate(); assert payment_writer.returncode == 0, error
    after_fault = snapshot()
    assert after_fault['booking']['online_paid_usd'] == 654
    assert after_fault['booking']['payment_confirmation_token'] == 'new-worker'
    assert after_fault['customer'] == snap['customer'] and after_fault['travellers'] == snap['travellers']
    assert after_fault['booking']['notes'] is None
    snap = after_fault
    sql('drop trigger ops_test_fail on booking_events; drop function ops_test_fail_audit()')
    sql(update(snap['revision']))
    current = snapshot()
    assert current['booking']['notes'] == 'edited'
    assert len(current['travellers']) == 1, 'legacy blank companion remains absent'
    try: sql(update(snap['revision'])); raise AssertionError('expected stale form failure')
    except AssertionError as error: assert 'stale booking record' in str(error)
    # Two operators submit the same rendered revision: exactly one commits.
    token = snapshot()['revision']
    editors = [subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',PREFIX+update(token)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
    results = [(p.communicate(),p.returncode) for p in editors]
    assert sorted(code for _,code in results) == [0,1], results
    assert 'stale booking record' in next(streams[1] for streams,code in results if code)
    # Foreign scope and non-service calls must fail without touching the row.
    before_scope = snapshot()
    try: sql(update(before_scope['revision']).replace(project,'00000000-0000-0000-0000-000000000000')); raise AssertionError('scope accepted')
    except AssertionError as error: assert 'booking not found' in str(error)
    try: sql("set request.jwt.claim.role='anon'; " + update(before_scope['revision'])); raise AssertionError('anon accepted')
    except AssertionError as error: assert 'service role required' in str(error)
    assert snapshot() == before_scope
    # Explicit allowlists preserve cash-paid history and confirmation leases.
    patch.update({'online_paid_usd':before_scope['booking']['online_paid_usd'],'family_cash_paid_usd':99999,'payment_confirmation_token':'forged','guest_count':1})
    sql(f"insert into booking_travellers(booking_id,position,is_lead,first_name,last_name) values ('{booking}',2,false,'Saved','Companion')")
    before_allowlist = snapshot()
    sql(update(before_allowlist['revision']))
    after_allowlist = snapshot()
    assert after_allowlist['booking']['family_cash_paid_usd'] == before_allowlist['booking']['family_cash_paid_usd']
    assert after_allowlist['booking']['payment_confirmation_token'] == before_allowlist['booking']['payment_confirmation_token']
    assert len(after_allowlist['travellers']) == 2, 'shrinking count must not remove saved companion'
    sql(f"update bookings set payment_confirmation_claimed_at=now() where id='{booking}'")
    after_allowlist = snapshot()
    patch['status'] = 'cancelled'
    try: sql(update(after_allowlist['revision'])); raise AssertionError('active lease cancellation accepted')
    except AssertionError as error: assert 'payment confirmation is in progress' in str(error)
    assert snapshot() == after_allowlist
    patch['status'] = 'application_received'
    sql(f"update bookings set payment_confirmation_token=null,payment_confirmation_claimed_at=null where id='{booking}'")
    sql(f"update bookings set status='awaiting_payment',online_paid_usd=0 where id='{booking}'")
    expected = snapshot()['booking']
    spec = {'client_reference_id':'OPS-CONCURRENCY','metadata':{'booking_id':booking,'customer_id':bid,'guest_count':str(expected['guest_count'])},'line_items':[{'quantity':1,'price_data':{'unit_amount':expected['online_due_usd']*100,'currency':'usd'}}]}
    claim = f"select prepare_booking_checkout('{booking}',{lit(expected)},{lit(spec)},'{{}}',null)"
    claims = [subprocess.Popen(['psql',DSN,'-XqAt','-v','ON_ERROR_STOP=1','-c',PREFIX+claim],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
    claim_results = [p.communicate() for p in claims]
    assert all(p.returncode == 0 for p in claims), claim_results
    assert claim_results[0][0] == claim_results[1][0], 'concurrent prepares must share one durable provider key'
    key = sql(claim)
    assert sql(claim) == key, 'durable provider key must survive retries'
    sql(f"update booking_checkout_ownership set created_at=now()-interval '24 hours' where booking_id='{booking}'")
    try: sql(claim); raise AssertionError('expected old attempt failure')
    except AssertionError as error: assert 'operator review' in str(error)
    print('PASS: 3 actual lock-wait races, audit atomicity, legacy blanks, stale form, durable checkout retry/expiry')
finally:
    sql("drop trigger if exists ops_test_fail on booking_events; drop function if exists ops_test_fail_audit()")
    sql(f"delete from booking_events where booking_id in (select id from bookings where customer_id='{bid}'); delete from bookings where customer_id='{bid}'; delete from customers where id='{bid}'")

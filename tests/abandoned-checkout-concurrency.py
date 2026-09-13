"""Real local PostgreSQL: parallel recovery claim and cancellation-first fence."""
import concurrent.futures
import json
import subprocess
import threading
import time

DSN = 'postgresql://localhost:55432/8l_test'
PREFIX = "set request.jwt.claim.role='service_role'; "

def sql(query):
    result = subprocess.run(['psql', DSN, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', PREFIX + query], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ''

customer = sql("insert into customers(first_name,last_name,email) values('Recovery','Race','recovery-race@example.invalid') returning id")
booking = None
try:
    project = sql("select id from tour_projects where slug='8-lakes-tours'")
    booking = sql(f"insert into bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd) values('{customer}','{project}','RECOVERY-RACE','Scheduled fixture','awaiting_payment',gen_random_uuid(),1,999,0) returning id")
    sql(f"update abandoned_checkout_recovery set eligible_at=now()-interval '1 minute' where booking_id='{booking}'")
    sql(f"insert into booking_checkout_ownership(booking_id,spec,expected,session_id) values('{booking}','{{\"line_items\":[{{\"price_data\":{{\"unit_amount\":99900}}}}]}}','{{}}','cs_recovery_race')")
    sql(f"insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values('{booking}','stripe','cs_recovery_race',999,'pending')")
    generation = sql(f"select generation from booking_checkout_ownership where booking_id='{booking}'")
    claim = f"select claim_abandoned_checkout('{booking}',array['Scheduled fixture'],'{{\"to\":\"recovery-race@example.invalid\",\"subject\":\"local-only\",\"text\":\"fixture\"}}')"
    barrier = threading.Barrier(2)
    def contender():
        barrier.wait()
        return json.loads(sql(claim))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: contender(), range(2)))
    assert sum(row['should_send'] for row in results) == 1, results
    owner = next(row for row in results if row['should_send'])
    authorize = f"select authorize_abandoned_checkout_v2('{booking}','{owner['claim_token']}',array['Scheduled fixture'],'{generation}',array['cs_recovery_race'])"
    writer = subprocess.Popen(['psql', DSN, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', f"begin;update bookings set status='cancelled' where id='{booking}';select pg_sleep(1);commit;"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for _ in range(80):
        if sql("select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%RECOVERY_NONMATCH%'".replace('RECOVERY_NONMATCH', booking)) != '0':
            break
        time.sleep(.02)
    else:
        raise AssertionError('cancellation did not hold booking lock')
    assert sql(authorize) == 'f', 'cancellation-first must suppress external send'
    _, error = writer.communicate()
    assert writer.returncode == 0, error
    print('PASS: independent concurrent claims => one owner; cancellation-first => authorization false')
finally:
    if booking:
        sql(f"delete from bookings where id='{booking}'")
    sql(f"delete from customers where id='{customer}'")
    assert sql("select count(*) from bookings where public_reference='RECOVERY-RACE'") == '0'

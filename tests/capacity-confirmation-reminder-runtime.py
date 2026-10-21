#!/usr/bin/env python3
"""Real PostgreSQL acceptance tests for capacity rollout authorization races."""
import os, pathlib, shutil, socket, subprocess, tempfile, threading, time
import psycopg
from psycopg.types.json import Jsonb

ROOT = pathlib.Path(__file__).resolve().parents[1]
PG = "/opt/homebrew/opt/postgresql@17/bin"
MIGRATIONS = [
    "0001_booking_ops_schema.sql", "0002_booking_events.sql", "20260910000000_booking_travellers.sql",
    "20260910020000_public_checkout_attempts.sql", "20260910030000_shared_checkout_ownership.sql",
    "20260910040000_initial_booking_notifications.sql", "20260910050000_abandoned_checkout_recovery.sql",
    "0004_booking_confirmation_lease.sql", "20260913000000_checkout_review_fences.sql",
    "20260918120000_abandoned_checkout_stage_cadence.sql", "20260925130000_departure_capacity_guard.sql",
]


def sql(conn, query, args=()):
    with conn.cursor() as cur:
        cur.execute(query) if not args else cur.execute(query, args)
        try:
            return cur.fetchall()
        except psycopg.ProgrammingError:
            return []


def wait_for_lock(observer, pids):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        seen = {row[0] for row in sql(observer, "select pid from pg_stat_activity where pid = any(%s) and wait_event_type = 'Lock'", (pids,))}
        if seen == set(pids):
            return
    raise AssertionError(f"lock wait not observed for workers {pids}")


def main():
    temp = pathlib.Path(tempfile.mkdtemp(prefix="8l-capacity-confirm-")); postgres = None
    sock = temp / "sock"; sock.mkdir()
    port_socket = socket.socket(); port_socket.bind(("127.0.0.1", 0)); port = port_socket.getsockname()[1]; port_socket.close()
    env = {**os.environ, "LC_ALL": "C"}
    try:
        subprocess.run([f"{PG}/initdb", "-D", str(temp / "data"), "-E", "UTF8", "--no-locale", "-A", "trust"], check=True, env=env, capture_output=True)
        postgres = subprocess.Popen([f"{PG}/postgres", "-D", str(temp / "data"), "-k", str(sock), "-p", str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        dsn = f"dbname=postgres host={sock} port={port} user={os.getenv('USER', 'postgres')}"
        while True:
            try:
                with psycopg.connect(dsn): break
            except psycopg.OperationalError:
                if time.monotonic() >= deadline: raise
        with psycopg.connect(dsn, autocommit=True) as conn:
            sql(conn, (ROOT / "supabase/migrations" / MIGRATIONS[0]).read_text())
            sql(conn, "create role anon; create role authenticated; create role service_role")
            for migration in MIGRATIONS[1:]:
                sql(conn, (ROOT / "supabase/migrations" / migration).read_text())
            sql(conn, "select set_config('request.jwt.claim.role','service_role',false)")
            project = sql(conn, "select id from public.tour_projects where slug='8-lakes-tours'")[0][0]
            customer = sql(conn, "insert into public.customers(first_name,last_name,email) values ('Test','Guest','test@example.invalid') returning id")[0][0]
            active_departure = sql(conn, "insert into public.departures(project_id,label,start_date,end_date,published,capacity_enforced) values (%s,'Scheduled fixture','2028-06-01','2028-06-09',true,true) returning id", (project,))[0][0]
            disabled_departure = sql(conn, "insert into public.departures(project_id,label,start_date,end_date,published,capacity_enforced) values (%s,'Disabled fixture','2028-07-01','2028-07-09',true,false) returning id", (project,))[0][0]

            def booking(ref, guests=1, date='Scheduled fixture', departure=None):
                bid = sql(conn, "insert into public.bookings(public_reference,project_id,customer_id,tour_date,guest_count,status,total_trip_value_usd,online_due_usd,family_cash_due_usd,submission_key) values (%s,%s,%s,%s,%s,'awaiting_payment',10,10,0,gen_random_uuid()) returning id", (ref, project, customer, date, guests))[0][0]
                if departure is not None:
                    sql(conn, "update public.bookings set departure_id=%s where id=%s", (departure, bid))
                return bid

            def payable(bid, session, pending=False):
                expected = sql(conn, "select jsonb_build_object('customer_id',customer_id,'tour_date',tour_date,'guest_count',guest_count,'online_due_usd',online_due_usd) from public.bookings where id=%s", (bid,))[0][0]
                spec = sql(conn, "select jsonb_build_object('client_reference_id',public_reference,'metadata',jsonb_build_object('booking_id',id::text,'customer_id',customer_id::text,'guest_count',guest_count::text),'line_items',jsonb_build_array(jsonb_build_object('price_data',jsonb_build_object('unit_amount',1000,'currency','usd'),'quantity','1'))) from public.bookings where id=%s", (bid,))[0][0]
                sql(conn, "insert into public.booking_checkout_ownership(booking_id,spec,expected,session_id,expired_sessions) values (%s,%s,%s,%s,array[%s])", (bid, Jsonb(spec), Jsonb(expected), session, session))
                sql(conn, "insert into public.payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values (%s,'stripe',%s,10,%s)", (bid, session, 'pending' if pending else 'paid'))
                return expected

            # Project rollout OFF preserves legacy confirmations even with unknown identity.
            legacy = booking('LEGACY', date='Unknown historic date'); legacy_expected = payable(legacy, 'cs_legacy')
            assert sql(conn, "select public.confirm_paid_booking_v2(%s,'cs_legacy',%s,'legacy-token',clock_timestamp())", (legacy, Jsonb(legacy_expected)))[0][0]['allowed'] is True

            sql(conn, "insert into public.departure_capacity_rollouts(project_id,enabled,enabled_at) values (%s,true,clock_timestamp())", (project,))
            # Project rollout ON fails closed for both unmapped and disabled identities, while paid ledger stays intact.
            unmapped = booking('UNMAPPED', date='Unknown historic date'); unmapped_expected = payable(unmapped, 'cs_unmapped')
            assert sql(conn, "select public.confirm_paid_booking_v2(%s,'cs_unmapped',%s,'unmapped-token',clock_timestamp())", (unmapped, Jsonb(unmapped_expected)))[0][0]['allowed'] is False
            assert sql(conn, "select status::text from public.bookings where id=%s", (unmapped,))[0][0] == 'awaiting_payment'
            assert sql(conn, "select status::text,amount_usd from public.payments where booking_id=%s", (unmapped,))[0] == ('paid', 10)
            disabled = booking('DISABLED', date='Disabled fixture', departure=disabled_departure); disabled_expected = payable(disabled, 'cs_disabled')
            assert sql(conn, "select public.confirm_paid_booking_v2(%s,'cs_disabled',%s,'disabled-token',clock_timestamp())", (disabled, Jsonb(disabled_expected)))[0][0]['allowed'] is False
            assert sql(conn, "select status::text from public.payments where booking_id=%s", (disabled,))[0][0] == 'paid'

            # A real queue/list claim, then exact expired release and competing fill, must deny the actual v3 RPC.
            sql(conn, "update public.abandoned_cadence_rollout set mode='test_allowlist'")
            target = booking('REMINDER', departure=active_departure); target_expected = payable(target, 'cs_expired', pending=True)
            assert sql(conn, "select public.reserve_departure_capacity(%s,'cs_expired')", (target,))[0][0] is True
            sql(conn, "update public.abandoned_checkout_recovery set tour_date='Scheduled fixture',eligible_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()+interval '2 days' where booking_id=%s", (target,))
            sql(conn, "insert into public.booking_travellers(booking_id,position,is_lead,first_name,last_name,email,nationality,date_of_birth,riding_experience) values (%s,1,true,'Test','Guest','test@example.invalid','US','1990-01-01','beginner')", (target,))
            sql(conn, "select public.abandoned_cadence_activate_booking(%s,'capacity-race-fixture')", (target,))
            listed = sql(conn, "select booking_id from public.list_abandoned_checkouts(array['Scheduled fixture']) where booking_id=%s", (target,))
            assert listed == [(target,)], listed
            payload = Jsonb({'to':'test@example.invalid','subject':'Complete booking','text':'private link'})
            claim = sql(conn, "select public.claim_abandoned_checkout(%s,array['Scheduled fixture'],%s)", (target, payload))[0][0]
            assert claim['should_send'] is True, claim
            assert sql(conn, "select public.release_departure_capacity_if_safe(%s,'cs_expired','expired')", (target,))[0][0] is True
            competitor = booking('COMPETING', guests=8, departure=active_departure)
            assert sql(conn, "select public.reserve_departure_capacity(%s,'cs_competing')", (competitor,))[0][0] is True
            authorized = sql(conn, "select public.authorize_abandoned_checkout_v3(%s,%s,array['Scheduled fixture'],(select generation from public.booking_checkout_ownership where booking_id=%s),array['cs_expired'],'abandoned_checkout_1')", (target, claim['claim_token'], target))[0][0]
            assert authorized is False
            assert sql(conn, "select coalesce(sum(guest_count),0) from public.departure_capacity_allocations where departure_id=%s", (active_departure,))[0][0] == 8

            # Confirmation and exact-session release race on independent connections; both wait on the booking lock.
            race = booking('RACE', departure=active_departure)
            # Move competitor out only for this isolated race; no capacity may exceed 8 in either outcome.
            sql(conn, "delete from public.departure_capacity_allocations where booking_id=%s", (competitor,))
            race_expected = payable(race, 'cs_race')
            assert sql(conn, "select public.reserve_departure_capacity(%s,'cs_race')", (race,))[0][0] is True
            lock = psycopg.connect(dsn, autocommit=False); sql(lock, "select set_config('request.jwt.claim.role','service_role',false)"); sql(lock, "select id from public.bookings where id=%s for update", (race,))
            results, pids = {}, []
            def worker(name, query, args):
                with psycopg.connect(dsn, autocommit=True) as c:
                    sql(c, "select set_config('request.jwt.claim.role','service_role',false)")
                    pids.append(sql(c, "select pg_backend_pid()")[0][0])
                    results[name] = sql(c, query, args)[0][0]
            confirm_thread = threading.Thread(target=worker, args=('confirm', "select public.confirm_paid_booking_v2(%s,'cs_race',%s,'race-token',clock_timestamp())", (race, Jsonb(race_expected))))
            release_thread = threading.Thread(target=worker, args=('release', "select public.release_departure_capacity_if_safe(%s,'cs_race','expired')", (race,)))
            confirm_thread.start(); release_thread.start()
            wait_deadline = time.monotonic() + 2
            while len(pids) != 2 and time.monotonic() < wait_deadline: pass
            assert len(pids) == 2, pids
            wait_for_lock(conn, pids)
            lock.commit(); lock.close(); confirm_thread.join(5); release_thread.join(5)
            assert not confirm_thread.is_alive() and not release_thread.is_alive()
            confirmed = results['confirm']['allowed']
            released = results['release']
            assert not (confirmed and released), results
            allocation = sql(conn, "select state from public.departure_capacity_allocations where booking_id=%s", (race,))
            status = sql(conn, "select status::text from public.bookings where id=%s", (race,))[0][0]
            assert (status == 'confirmed') == bool(allocation), (status, allocation, results)
            if allocation: assert allocation == [('confirmed',)], allocation
            assert sql(conn, "select coalesce(sum(guest_count),0) <= 8 from public.departure_capacity_allocations where departure_id=%s", (active_departure,))[0][0] is True
        print('PASS real RPC compatibility/rejection, list-claim-fill authorization fence, and observed-lock confirm/release race')
    finally:
        if postgres and postgres.poll() is None:
            postgres.terminate()
            try: postgres.wait(timeout=10)
            except subprocess.TimeoutExpired: postgres.kill()
        shutil.rmtree(temp, ignore_errors=True)

if __name__ == '__main__': main()

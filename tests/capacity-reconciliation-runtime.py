#!/usr/bin/env python3
"""Fresh-cluster integration for reconciliation candidate pagination and release fences."""
import os, pathlib, shutil, socket, subprocess, tempfile, time
import psycopg

ROOT = pathlib.Path(__file__).resolve().parents[1]
PG = "/opt/homebrew/opt/postgresql@17/bin"


def sql(conn, query, args=()):
    with conn.cursor() as cur:
        cur.execute(query) if not args else cur.execute(query, args)
        try:
            return cur.fetchall()
        except psycopg.ProgrammingError:
            return []


def main():
    temp = pathlib.Path(tempfile.mkdtemp(prefix="8l-reconciliation-pg-")); postgres = None
    sock = temp / "sock"; sock.mkdir()
    port_socket = socket.socket(); port_socket.bind(("127.0.0.1", 0)); port = port_socket.getsockname()[1]; port_socket.close()
    env = {**os.environ, "LC_ALL": "C"}
    try:
        subprocess.run([f"{PG}/initdb", "-D", str(temp / "data"), "-E", "UTF8", "--no-locale", "-A", "trust"], check=True, env=env, capture_output=True)
        postgres = subprocess.Popen([f"{PG}/postgres", "-D", str(temp / "data"), "-k", str(sock), "-p", str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        dsn = f"dbname=postgres host={sock} port={port} user={os.getenv('USER', 'postgres')}"
        deadline = time.monotonic() + 5
        while True:
            try:
                with psycopg.connect(dsn): break
            except psycopg.OperationalError:
                if time.monotonic() >= deadline: raise
        with psycopg.connect(dsn, autocommit=True) as conn:
            migrations = sorted((ROOT / "supabase/migrations").glob("*.sql"))
            for i, migration in enumerate(migrations):
                sql(conn, migration.read_text())
                if i == 0:
                    sql(conn, "create role anon; create role authenticated; create role service_role")
            sql(conn, "select set_config('request.jwt.claim.role','service_role',false)")
            project = sql(conn, "select id from public.tour_projects where slug='8-lakes-tours'")[0][0]
            departure, label = sql(conn, "select id,label from public.departures where project_id=%s order by start_date limit 1", (project,))[0]
            sql(conn, "update public.departures set capacity_enforced=true where id=%s", (departure,))
            customer = sql(conn, "insert into public.customers(first_name,last_name,email) values ('Recon','Test','recon@example.invalid') returning id")[0][0]

            def booking(ref, status='awaiting_payment'):
                return sql(conn, "insert into public.bookings(public_reference,project_id,customer_id,tour_date,guest_count,status,total_trip_value_usd,online_due_usd,family_cash_due_usd) values (%s,%s,%s,%s,1,%s,10,10,0) returning id", (ref, project, customer, label, status))[0][0]

            # Candidate RPC must page the complete exact set (including the 51st row)
            # in tuple order without duplicates or omissions.
            fixture = []
            for i in range(55):
                bid = booking(f'PAGE-{i:02d}')
                sid = f'cs-page-{i:02d}'
                sql(conn, "insert into public.departure_capacity_allocations(booking_id,departure_id,guest_count,checkout_session_id,state,allocated_at) values (%s,%s,1,%s,'payment',clock_timestamp()+%s * interval '1 second')", (bid, departure, sid, i))
                sql(conn, "insert into public.payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values (%s,'stripe',%s,10,'pending')", (bid, sid))
                fixture.append((bid, sid))
            before = sql(conn, "select clock_timestamp()+interval '2 minutes'")[0][0]
            page1 = sql(conn, "select booking_id,payment_session_ids,allocated_at from public.list_departure_capacity_reconciliation_candidates(null,null,%s,50)", (before,))
            assert len(page1) == 50
            page2 = sql(conn, "select booking_id,payment_session_ids,allocated_at from public.list_departure_capacity_reconciliation_candidates(%s,%s,%s,50)", (page1[-1][2], page1[-1][0], before))
            ids = [row[0] for row in page1 + page2]
            assert len(page2) == 5 and len(ids) == 55 and len(set(ids)) == 55, (len(page1), len(page2), len(set(ids)))
            assert ids == sorted(ids, key=lambda bid: next(index for index, item in enumerate(fixture) if item[0] == bid))
            assert all(row[1] == [next(sid for bid, sid in fixture if bid == row[0])] for row in page1 + page2)

            # The new functions are service-role only.
            sql(conn, "set role authenticated")
            try:
                sql(conn, "select public.list_departure_capacity_reconciliation_candidates(null,null,clock_timestamp(),1)")
                raise AssertionError('authenticated role unexpectedly executed candidate RPC')
            except psycopg.errors.InsufficientPrivilege:
                pass
            try:
                sql(conn, "select public.release_departure_capacity_if_all_expired_safe(gen_random_uuid(),array['cs-nope'],'expired')")
                raise AssertionError('authenticated role unexpectedly executed release RPC')
            except psycopg.errors.InsufficientPrivilege:
                pass
            finally:
                sql(conn, "reset role")
            sql(conn, "select set_config('request.jwt.claim.role','service_role',false)")

            # All related pending Stripe sessions can be provider-verified expired;
            # release succeeds and preserves the local pending ledger rows.
            expired = booking('EXPIRED-ALL')
            sql(conn, "insert into public.departure_capacity_allocations(booking_id,departure_id,guest_count,checkout_session_id,state) values (%s,%s,1,'cs-current','payment')", (expired, departure))
            for sid in ('cs-old', 'cs-current'):
                sql(conn, "insert into public.payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values (%s,'stripe',%s,10,'pending')", (expired, sid))
            assert sql(conn, "select public.release_departure_capacity_if_all_expired_safe(%s,array['cs-current','cs-old'],'expired')", (expired,))[0][0] is True
            assert sql(conn, "select array_agg(status::text order by stripe_checkout_session_id) from public.payments where booking_id=%s", (expired,))[0][0] == ['pending','pending']
            assert sql(conn, "select count(*) from public.departure_capacity_allocations where booking_id=%s", (expired,))[0][0] == 0

            # A payment created after provider retrieval but before finalization makes
            # the exact-set RPC fail closed and keeps the allocation.
            changed = booking('NEW-PAYMENT')
            sql(conn, "insert into public.departure_capacity_allocations(booking_id,departure_id,guest_count,checkout_session_id,state) values (%s,%s,1,'cs-before','payment')", (changed, departure))
            for sid in ('cs-before', 'cs-added'):
                sql(conn, "insert into public.payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values (%s,'stripe',%s,10,'pending')", (changed, sid))
            assert sql(conn, "select public.release_departure_capacity_if_all_expired_safe(%s,array['cs-before'],'expired')", (changed,))[0][0] is False
            assert sql(conn, "select count(*) from public.departure_capacity_allocations where booking_id=%s", (changed,))[0][0] == 1

            # A cancelled confirmed allocation can combine historic expired/unpaid
            # and current paid/fully-refunded provider evidence without rewriting
            # either ledger status.
            cancelled = booking('MIXED-CANCELLED', 'cancelled')
            sql(conn, "insert into public.departure_capacity_allocations(booking_id,departure_id,guest_count,checkout_session_id,state) values (%s,%s,1,'cs-paid','confirmed')", (cancelled, departure))
            sql(conn, "insert into public.payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values (%s,'stripe','cs-old-cancel',10,'pending'),(%s,'stripe','cs-paid',10,'paid')", (cancelled, cancelled))
            assert sql(conn, "select public.release_confirmed_departure_capacity_on_cancel_if_safe(%s,array['cs-old-cancel'],array['cs-paid'],'cancelled_refunded')", (cancelled,))[0][0] is True
            assert sql(conn, "select array_agg(status::text order by stripe_checkout_session_id) from public.payments where booking_id=%s", (cancelled,))[0][0] == ['pending','paid']
            assert sql(conn, "select count(*) from public.departure_capacity_allocations where booking_id=%s", (cancelled,))[0][0] == 0
        print('PASS fresh complete-migration PostgreSQL reconciliation pagination, permissions, exact-set release, and fail-closed changed payment')
    finally:
        if postgres and postgres.poll() is None:
            postgres.terminate()
            try: postgres.wait(timeout=10)
            except subprocess.TimeoutExpired: postgres.kill()
        shutil.rmtree(temp, ignore_errors=True)


if __name__ == '__main__': main()

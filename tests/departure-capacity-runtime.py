#!/usr/bin/env python3
"""Real PostgreSQL acceptance tests for the 8 Lakes departure-capacity fence."""
import os, pathlib, shutil, socket, subprocess, tempfile, threading, time, uuid
import psycopg

ROOT = pathlib.Path(__file__).resolve().parents[1]
PG = "/opt/homebrew/opt/postgresql@17/bin"


def sql(conn, query, args=()):
    with conn.cursor() as cur:
        cur.execute(query) if not args else cur.execute(query, args)
        try: return cur.fetchall()
        except psycopg.ProgrammingError: return []


def main():
    temp = pathlib.Path(tempfile.mkdtemp(prefix="8l-capacity-pg-"))
    port_socket = socket.socket(); port_socket.bind(("127.0.0.1", 0)); port = port_socket.getsockname()[1]; port_socket.close()
    data, sock = temp / "data", temp / "sock"; sock.mkdir()
    env = {**os.environ, "LC_ALL": "C"}
    postgres = None
    try:
        subprocess.run([f"{PG}/initdb", "-D", str(data), "-E", "UTF8", "--no-locale", "-A", "trust"], check=True, env=env, capture_output=True)
        postgres = subprocess.Popen([f"{PG}/postgres", "-D", str(data), "-k", str(sock), "-p", str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.4)
        dsn = f"dbname=postgres host={sock} port={port} user={os.getenv('USER', 'postgres')}"
        with psycopg.connect(dsn, autocommit=True) as conn:
            sql(conn, (ROOT / "supabase/migrations/0001_booking_ops_schema.sql").read_text())
            sql(conn, "create role anon; create role authenticated; create role service_role")
            sql(conn, (ROOT / "supabase/migrations/20260910000000_booking_travellers.sql").read_text())
            sql(conn, (ROOT / "supabase/migrations/20260910020000_public_checkout_attempts.sql").read_text())
            sql(conn, (ROOT / "supabase/migrations/20260910030000_shared_checkout_ownership.sql").read_text())
            sql(conn, (ROOT / "supabase/migrations/20260910040000_initial_booking_notifications.sql").read_text())
            sql(conn, (ROOT / "supabase/migrations/20260910050000_abandoned_checkout_recovery.sql").read_text())
            sql(conn, (ROOT / "supabase/migrations/0004_booking_confirmation_lease.sql").read_text())
            sql(conn, (ROOT / "supabase/migrations/20260913000000_checkout_review_fences.sql").read_text())
            sql(conn, (ROOT / "supabase/migrations/20260925130000_departure_capacity_guard.sql").read_text())
            print('seed', flush=True)
            sql(conn, "select set_config('request.jwt.claim.role','service_role',false)")
            project = sql(conn, "insert into public.tour_projects(slug,name,active) values ('capacity-test','Capacity test',true) returning id")[0][0]
            dep = sql(conn, "insert into public.departures(project_id,label,start_date,end_date,published,capacity_enforced) values (%s,'July 6 – 14, 2026','2026-07-06','2026-07-14',true,true) returning id", (project,))[0][0]
            customer = sql(conn, "insert into public.customers(first_name,last_name,email) values ('Test','Guest','test@example.invalid') returning id")[0][0]
            def booking(n, guests=1, label='July 6 – 14, 2026'):
                return sql(conn, "insert into public.bookings(public_reference,project_id,customer_id,tour_date,guest_count,status,total_trip_value_usd,online_due_usd,family_cash_due_usd) values (%s,%s,%s,%s,%s,'awaiting_payment',1,1,0) returning id", (f'CAP-{n}',project,customer,label,guests))[0][0]
            seven = booking('seven', 7); sql(conn, "select public.reserve_departure_capacity(%s)", (seven,))
            a, b = booking('a'), booking('b')
            outcomes=[]
            def reserve(i):
                with psycopg.connect(dsn, autocommit=True) as c:
                    sql(c, "select set_config('request.jwt.claim.role','service_role',false)")
                    try: outcomes.append((i, sql(c, "select public.reserve_departure_capacity(%s)", (i,))[0][0]))
                    except Exception as e: outcomes.append((i, False))
            ts=[threading.Thread(target=reserve,args=(x,)) for x in (a,b)]
            [t.start() for t in ts]; [t.join() for t in ts]
            assert sum(ok for _, ok in outcomes) == 1, outcomes
            count=sql(conn,"select coalesce(sum(guest_count),0) from public.departure_capacity_allocations where departure_id=%s",(dep,))[0][0]
            assert count == 8, count
            # A full departure rejects an Ops count/date mutation atomically.
            winner = next(i for i, ok in outcomes if ok)
            try: sql(conn,"update public.bookings set guest_count=2 where id=%s",(winner,)); raise AssertionError('over-capacity ops edit committed')
            except psycopg.Error: pass
            assert sql(conn,"select guest_count from public.bookings where id=%s",(winner,))[0][0] == 1
            # Unknown labels are not eligible for automatic allocation.
            unknown=booking('unknown',1,'Made up departure')
            assert sql(conn,"select public.reserve_departure_capacity(%s)",(unknown,))[0][0] is False
            # Cancellation/refund never silently releases a provider-owned allocation.
            winner = next(i for i, ok in outcomes if ok)
            sql(conn,"update public.bookings set status='cancelled' where id=%s",(winner,))
            assert sql(conn,"select count(*) from public.departure_capacity_allocations where booking_id=%s",(winner,))[0][0] == 1
            # A transient provider outcome remains allocated, not clock-released.
            assert sql(conn,"select public.release_departure_capacity_if_safe(%s,'processing')",(winner,))[0][0] is False
            assert sql(conn,"select count(*) from public.departure_capacity_allocations where booking_id=%s",(winner,))[0][0] == 1
        print('PASS real PostgreSQL capacity concurrency, ops rollback, fail-closed and no-auto-release')
    finally:
        if postgres and postgres.poll() is None:
            postgres.terminate()
            try: postgres.wait(timeout=10)
            except subprocess.TimeoutExpired: postgres.kill()
        shutil.rmtree(temp, ignore_errors=True)

if __name__ == '__main__': main()

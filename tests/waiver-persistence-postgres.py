#!/usr/bin/env python3
"""Fresh, isolated Homebrew PostgreSQL regression runner for rider waivers."""
import os, pathlib, shutil, socket, subprocess, tempfile, threading, time
import psycopg

ROOT = pathlib.Path(__file__).resolve().parents[1]


def homebrew_postgres_bin():
    brew = shutil.which("brew")
    if not brew:
        raise RuntimeError("Homebrew is required for the isolated PostgreSQL runner")
    for formula in ("postgresql@17", "postgresql@16", "postgresql"):
        result = subprocess.run([brew, "--prefix", formula], text=True, capture_output=True)
        candidate = pathlib.Path(result.stdout.strip()) / "bin"
        if result.returncode == 0 and (candidate / "initdb").is_file() and (candidate / "postgres").is_file():
            return str(candidate)
    raise RuntimeError("install a Homebrew postgresql formula (postgresql@17, @16, or postgresql) to run waiver PG tests")


PG = homebrew_postgres_bin()
MIGRATION = ROOT / "supabase/migrations/20261007000000_rider_waivers.sql"
RUNTIME_SQL = ROOT / "tests/waiver-persistence-runtime.sql"
LEGAL_TEXT = "legal text " * 20


def query(conn, statement, params=()):
    with conn.cursor() as cur:
        if params:
            cur.execute(statement, params)
        else:
            cur.execute(statement)
        try:
            return cur.fetchall()
        except psycopg.ProgrammingError:
            return []


def waiver_args(reference, email, dob, key, rider="Alice Rider", guardian_name=None,
                guardian_relationship=None, signature=None, version="2026-10-06", legal_text=LEGAL_TEXT):
    return (reference, "8-lakes-tours", rider, email, dob, guardian_name, guardian_relationship,
            signature or rider, version, legal_text, key, None, "unavailable", None)


def assert_snapshot_conflict(conn, operation):
    try:
        operation()
    except psycopg.Error as error:
        assert error.sqlstate == "P0003", f"expected immutable snapshot conflict, got {error.sqlstate}: {error}"
        conn.rollback()
    else:
        raise AssertionError("immutable waiver snapshot mismatch was accepted")


def record(conn, *args):
    bound = args[:10] + (args[9],) + args[10:]
    return query(conn, "select * from public.record_rider_waiver(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,encode(digest(convert_to(%s,'UTF8'),'sha256'),'hex'),%s,%s,%s,%s)", bound)[0]


def main():
    root = pathlib.Path(tempfile.mkdtemp(prefix="8l-waiver-pg-", dir=os.environ.get("TMPDIR")))
    socket_dir = root / "socket"; socket_dir.mkdir()
    probe = socket.socket(); probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]; probe.close()
    env = {**os.environ, "LC_ALL": "C"}
    postgres = None
    try:
        subprocess.run([f"{PG}/initdb", "-D", str(root / "data"), "-E", "UTF8", "--no-locale", "-A", "trust"], check=True, env=env, capture_output=True)
        postgres = subprocess.Popen([f"{PG}/postgres", "-D", str(root / "data"), "-k", str(socket_dir), "-p", str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        dsn = f"dbname=postgres host={socket_dir} port={port} user={os.getenv('USER', 'postgres')}"
        deadline = time.monotonic() + 10
        while True:
            try:
                with psycopg.connect(dsn): break
            except psycopg.OperationalError:
                if time.monotonic() > deadline: raise
                time.sleep(0.05)
        with psycopg.connect(dsn, autocommit=True) as admin:
            query(admin, "create extension pgcrypto; create role anon; create role authenticated; create role service_role")
            query(admin, "create table public.tour_projects(id uuid primary key, slug text unique not null, active boolean not null)")
            query(admin, "create table public.bookings(id uuid primary key, project_id uuid not null references public.tour_projects(id), public_reference text not null)")
            query(admin, "create table public.booking_travellers(id uuid primary key, booking_id uuid not null references public.bookings(id), position integer not null, first_name text not null, last_name text not null, email text, date_of_birth date not null)")
            query(admin, MIGRATION.read_text())
            # psql's ON_ERROR_STOP meta-command is not SQL; execute the rest directly.
            query(admin, '\n'.join(RUNTIME_SQL.read_text().splitlines()[1:]))
            query(admin, "insert into public.tour_projects values(gen_random_uuid(),'8-lakes-tours',true)")
            query(admin, "insert into public.bookings select gen_random_uuid(),id,'8L-TEST01' from public.tour_projects")
            booking = query(admin, "select id from public.bookings where public_reference='8L-TEST01'")[0][0]
            for position, email in enumerate(("alice@example.invalid", "bob@example.invalid", "cara@example.invalid"), 1):
                name = ("Alice", "Bob", "Cara")[position - 1]
                query(admin, "insert into public.booking_travellers values(gen_random_uuid(),%s,%s,%s,'Rider',%s,'1990-02-03')", (booking, position, name, email))
            query(admin, "insert into public.booking_travellers values(gen_random_uuid(),%s,4,'Minor','Rider','minor@example.invalid','2010-02-03')", (booking,))
            query(admin, "insert into public.bookings select gen_random_uuid(),id,'8L-TEST02' from public.tour_projects")
            other_booking = query(admin, "select id from public.bookings where public_reference='8L-TEST02'")[0][0]
            query(admin, "insert into public.booking_travellers values(gen_random_uuid(),%s,1,'Alice','Rider','alice@example.invalid','1990-02-03')", (other_booking,))

        def service_conn():
            conn = psycopg.connect(dsn)
            query(conn, "select set_config('request.jwt.claim.role','service_role',false)")
            return conn

        # An unmatched typo is durable evidence, but cannot poison a later corrected,
        # legitimate match because email is part of the submission identity.
        with service_conn() as conn:
            unmatched = record(conn, *waiver_args("8L-TEST01", "alice-typo@example.invalid", "1990-02-03", "9" * 64))
            assert unmatched[1] == "unmatched"
            conn.commit()
            waiver = record(conn, *waiver_args("8L-TEST01", "alice@example.invalid", "1990-02-03", "a" * 64))
            assert waiver[1] == "matched"
            conn.commit()
            canonical_retry = record(conn, *waiver_args("8L-TEST01", " ALICE@EXAMPLE.INVALID ", "1990-02-03", "a" * 64))
            assert canonical_retry[0] == waiver[0] and canonical_retry[2] is False
            conn.commit()

            # A key collision may not bridge booking scope, and a traveller/version
            # retry must preserve every immutable signed field.
            assert_snapshot_conflict(conn, lambda: record(conn, *waiver_args("8L-TEST02", "alice@example.invalid", "1990-02-03", "a" * 64)))
            for changed in (
                waiver_args("8L-TEST01", "other@example.invalid", "1990-02-03", "a" * 64),
                waiver_args("8L-TEST01", "alice@example.invalid", "1991-02-03", "a" * 64),
                waiver_args("8L-TEST01", "alice@example.invalid", "1990-02-03", "a" * 64, signature="Alice  Rider"),
                waiver_args("8L-TEST01", "alice@example.invalid", "1990-02-03", "a" * 64, version="2026-10-07"),
                waiver_args("8L-TEST01", "alice@example.invalid", "1990-02-03", "a" * 64, legal_text=LEGAL_TEXT + "changed"),
            ):
                assert_snapshot_conflict(conn, lambda changed=changed: record(conn, *changed))
            minor = record(conn, *waiver_args("8L-TEST01", "minor@example.invalid", "2010-02-03", "e" * 64,
                                               rider="Minor Rider", guardian_name="Guardian Rider",
                                               guardian_relationship="parent", signature="Guardian Rider"))
            assert minor[1] == "matched"
            conn.commit()
            assert_snapshot_conflict(conn, lambda: record(conn, *waiver_args("8L-TEST01", "minor@example.invalid", "2010-02-03", "f" * 64,
                                                                                rider="Minor Rider", guardian_name="Guardian Rider",
                                                                                guardian_relationship="legal guardian", signature="Guardian Rider")))

            wid = waiver[0]
            first = query(conn, "select * from public.claim_rider_waiver_email_dispatch(%s,'rider','alice@example.invalid',gen_random_uuid(),clock_timestamp())", (wid,))[0]
            token = query(conn, "select claim_token from public.rider_waiver_email_dispatches where id=%s", (first[1],))[0][0]
            assert query(conn, "select public.mark_rider_waiver_email_provider_attempted(%s,%s)", (first[1], token))[0][0]
            assert query(conn, "select public.complete_rider_waiver_email_dispatch(%s,%s,true,false,'provider-1')", (first[1], token))[0][0]
            sent = query(conn, "select * from public.claim_rider_waiver_email_dispatch(%s,'rider','attacker@example.invalid',gen_random_uuid(),clock_timestamp())", (wid,))[0]
            assert not sent[0] and sent[2] == "alice@example.invalid" and sent[4] == "sent"

            failed = query(conn, "select * from public.claim_rider_waiver_email_dispatch(%s,'internal','ops@example.invalid',gen_random_uuid(),clock_timestamp())", (wid,))[0]
            failed_token = query(conn, "select claim_token from public.rider_waiver_email_dispatches where id=%s", (failed[1],))[0][0]
            assert not query(conn, "select public.mark_rider_waiver_email_provider_attempted(%s,gen_random_uuid())", (failed[1],))[0][0], "token fence failed"
            assert query(conn, "select public.mark_rider_waiver_email_provider_attempted(%s,%s)", (failed[1], failed_token))[0][0]
            assert not query(conn, "select public.complete_rider_waiver_email_dispatch(%s,gen_random_uuid(),false,true,null)", (failed[1],))[0][0], "finalization token fence failed"
            assert query(conn, "select public.complete_rider_waiver_email_dispatch(%s,%s,false,true,null)", (failed[1], failed_token))[0][0]
            retry = query(conn, "select * from public.claim_rider_waiver_email_dispatch(%s,'internal','attacker@example.invalid',gen_random_uuid(),clock_timestamp())", (wid,))[0]
            assert retry[0] and retry[2] == "ops@example.invalid", "known rejection was not safely retried"

            crash = record(conn, *waiver_args("8L-TEST01", "bob@example.invalid", "1990-02-03", "b" * 64, "Bob Rider"))
            crash_claim = query(conn, "select * from public.claim_rider_waiver_email_dispatch(%s,'rider','bob@example.invalid',gen_random_uuid(),'2026-10-07 00:00:00+00')", (crash[0],))[0]
            crash_token = query(conn, "select claim_token from public.rider_waiver_email_dispatches where id=%s", (crash_claim[1],))[0][0]
            assert query(conn, "select public.mark_rider_waiver_email_provider_attempted(%s,%s,'2026-10-07 00:00:00+00')", (crash_claim[1], crash_token))[0][0]
            reconciled = query(conn, "select * from public.claim_rider_waiver_email_dispatch(%s,'rider','attacker@example.invalid',gen_random_uuid(),'2026-10-07 00:06:00+00')", (crash[0],))[0]
            assert not reconciled[0] and reconciled[2] == "bob@example.invalid" and reconciled[4] == "reconciliation_required", "stale attempted claim retried"

        # Two actual PostgreSQL connections race distinct submissions for one booking.
        first = service_conn(); second = service_conn(); results = []; started = threading.Event()
        def second_writer():
            started.set()
            results.append(record(second, *waiver_args("8L-TEST01", "cara@example.invalid", "1990-02-03", "d" * 64, "Cara Rider")))
            second.commit()
        try:
            first_result = record(first, *waiver_args("8L-TEST01", "cara@example.invalid", "1990-02-03", "c" * 64, "Cara Rider"))
            thread = threading.Thread(target=second_writer); thread.start(); started.wait(1); time.sleep(0.2)
            assert thread.is_alive(), "second writer did not wait on booking FOR UPDATE"
            first.commit(); thread.join(5); assert not thread.is_alive()
            assert results[0][0] == first_result[0] and results[0][2] is False
        finally:
            first.close(); second.close()

        # Direct evidence/RPC access remains unavailable to public roles.
        for role in ("anon", "authenticated"):
            with psycopg.connect(dsn) as conn:
                query(conn, f"set role {role}")
                try:
                    query(conn, "select * from public.rider_waivers")
                    raise AssertionError(f"{role} read private waivers")
                except psycopg.errors.InsufficientPrivilege:
                    conn.rollback()
        print("PASS isolated PostgreSQL: ACLs, sent dedupe, failed retry, token fences, stale crash reconciliation, and booking-lock concurrency")
    finally:
        if postgres and postgres.poll() is None:
            postgres.terminate()
            try: postgres.wait(timeout=10)
            except subprocess.TimeoutExpired: postgres.kill()
        shutil.rmtree(root, ignore_errors=True)

if __name__ == "__main__":
    main()

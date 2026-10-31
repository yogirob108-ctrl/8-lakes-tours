"""PostgreSQL concurrency regression; defaults to remote only when no local DSN is supplied."""
import importlib.util
import os
import threading
import uuid
from pathlib import Path

import psycopg

LOCAL_DSN = os.environ.get('LIFECYCLE_CONCURRENCY_TEST_DSN')
if LOCAL_DSN and ('host=127.0.0.1' not in LOCAL_DSN or 'dbname=attestation_test' not in LOCAL_DSN):
    raise RuntimeError('Requires explicit isolated local attestation_test database')

spec = importlib.util.spec_from_file_location('transport', '/tmp/8l-access-recovered/transport.py')
transport = None
if not LOCAL_DSN:
    assert spec and spec.loader
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)


def connect():
    if LOCAL_DSN:
        db = psycopg.connect(LOCAL_DSN)
        db.execute("set request.jwt.claim.role='service_role'")
        return db
    return transport.connect(False)


root = Path('/Users/kokos/Projects/8-lakes-public-lifecycle')
with connect() as db:
    project = db.execute("select id from public.tour_projects where slug='8-lakes-tours'").fetchone()[0]
    customer = db.execute("insert into public.customers(first_name,last_name,email) values('Concurrent','Runtime','lifecycle-concurrent@example.invalid') returning id").fetchone()[0]
    booking = db.execute("insert into public.bookings(customer_id,project_id,public_reference,tour_date,status,online_due_usd,online_paid_usd) values(%s,%s,%s,'Scheduled fixture','confirmed',999,999) returning id", (customer, project, f'LIFECYCLE-CONCURRENT-{uuid.uuid4().hex[:8]}')).fetchone()[0]
    db.commit()

barrier = threading.Barrier(2)
outcomes = []
def claim(template):
    with connect() as db:
        barrier.wait()
        row = db.execute("select public.claim_lifecycle_email_dispatch(%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp())", (booking, customer, template, 'lifecycle-concurrent@example.invalid', template, 'body', 'postgres-concurrency-test', uuid.uuid4())).fetchone()[0]
        db.commit()
        outcomes.append(row)

threads = [threading.Thread(target=claim, args=(template,)) for template in ('preparation_packing', 'insurance_final_check')]
for thread in threads: thread.start()
for thread in threads: thread.join()

with connect() as db:
    dispatches = db.execute('select status,template_key from public.lifecycle_email_dispatches where booking_id=%s', (booking,)).fetchall()
    db.execute('delete from public.bookings where id=%s', (booking,))
    db.execute('delete from public.customers where id=%s', (customer,))
    db.commit()

assert sum(bool(row.get('should_send')) for row in outcomes) == 1, outcomes
assert len(dispatches) == 1 and dispatches[0][0] == 'queued', dispatches
print({'concurrent_claims': outcomes, 'durable_dispatch_rows': dispatches})

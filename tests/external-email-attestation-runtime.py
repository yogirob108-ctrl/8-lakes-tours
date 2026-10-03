"""Local disposable PostgreSQL only. No provider calls or production credentials."""
import concurrent.futures
import datetime as dt
import os
import time
import unittest
import uuid
import psycopg

DSN = os.environ.get('ATTESTATION_TEST_DSN', 'host=127.0.0.1 port=55439 user=postgres dbname=attestation_test')
if 'host=127.0.0.1' not in DSN or 'dbname=attestation_test' not in DSN:
    raise RuntimeError('Requires explicit isolated local attestation_test database')


def connect():
    c = psycopg.connect(DSN, autocommit=True)
    c.execute("set request.jwt.claim.role='service_role'")
    return c


class AttestationTests(unittest.TestCase):
    def setUp(self):
        self.c = connect()
        self.project = self.c.execute("select id from tour_projects where slug='8-lakes-tours'").fetchone()[0]
        self.customer = self.c.execute("insert into customers(first_name,last_name,email) values ('Synthetic','Fixture',%s) returning id", (f'{uuid.uuid4()}@example.invalid',)).fetchone()[0]
        self.ref = f'ATTEST-{uuid.uuid4()}'
        self.booking = self.c.execute("insert into bookings(project_id,customer_id,public_reference,status,tour_date) values (%s,%s,%s,'confirmed','October 21 – 29, 2026') returning id", (self.project,self.customer,self.ref)).fetchone()[0]
        self.sent = dt.datetime.now(dt.timezone.utc)-dt.timedelta(minutes=10)
        self.key = str(uuid.uuid4())
        self.fixture_booking_ids = [self.booking]
        self.fixture_customer_ids = [self.customer]

    def tearDown(self):
        self.c.execute('delete from lifecycle_email_dispatches where booking_id = any(%s)', (self.fixture_booking_ids,))
        self.c.execute('delete from public_booking_notifications where booking_id = any(%s)', (self.fixture_booking_ids,))
        self.c.execute('delete from email_events where booking_id = any(%s)', (self.fixture_booking_ids,))
        self.c.execute('delete from bookings where id = any(%s)', (self.fixture_booking_ids,))
        self.c.execute('delete from customers where id = any(%s)', (self.fixture_customer_ids,))
        self.c.close()

    def record(self, c=None, **kw):
        args = [self.project, self.ref, 'preparation_packing', self.sent, 'Sent from Gmail', self.key]
        for k,v in kw.items(): args[int(k)] = v
        return (c or self.c).execute('select public.record_external_email_attestation(%s,%s,%s,%s,%s,%s)', args).fetchone()[0]

    def test_atomic_truthful_record_and_retry(self):
        result = self.record()
        self.assertEqual(result['outcome'], 'recorded')
        self.assertEqual(self.record()['event_id'], result['event_id'])
        row = self.c.execute("select template_key,body_snapshot,provider,raw_response,sent_at from email_events where booking_id=%s", (self.booking,)).fetchall()
        self.assertEqual(len(row),1)
        self.assertEqual(row[0][1], '')
        self.assertEqual(row[0][2], 'gmail')
        self.assertFalse(row[0][3]['provider_delivery'])
        self.assertIn('recorded_at',row[0][3])
        self.assertEqual(row[0][4], self.sent)
        self.assertEqual(self.c.execute("select count(*) from booking_events where booking_id=%s",(self.booking,)).fetchone()[0],1)

    def test_invalid_inputs(self):
        for key,value in [('0',None),('1',None),('2',None),('2','internal_booking_notification'),('2','booking_received'),('3',None),('3',dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=1)),('4','x'*1001),('5',''),('5',None)]:
            with self.subTest(key=key,value=str(value)[:25]):
                with self.assertRaises(psycopg.Error): self.record(**{key:value})

    def test_all_supported_aliases_store_ops_canonical_keys(self):
        aliases = {
            'payment_confirmed': 'booking_confirmed', 'booking_confirmed': 'booking_confirmed',
            'preparation_packing': 'packing_list', 'packing_list': 'packing_list',
            'insurance_final_check': 'insurance_reminder', 'insurance_reminder': 'insurance_reminder',
            'arrival_coordination': 'arrival_details', 'arrival_details': 'arrival_details',
            'final_checklist': 'final_checklist', 'post_trip_followup': 'post_trip_followup',
        }
        for supplied, expected in aliases.items():
            with self.subTest(supplied=supplied):
                result = self.c.execute(
                    'select public.record_external_email_attestation(%s,%s,%s,%s,%s,%s)',
                    (self.project, self.ref, supplied, self.sent, None, str(uuid.uuid4())),
                ).fetchone()[0]
                key = self.c.execute('select template_key from email_events where id=%s', (result['event_id'],)).fetchone()[0]
                self.assertEqual(key, expected)

    def test_fresh_automatic_claim_still_queues_after_lock(self):
        outcome = self.c.execute(
            "select public.claim_lifecycle_email_dispatch(%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp())",
            (self.booking, self.customer, 'preparation_packing', 'synthetic@example.invalid', 'automatic subject', '', 'automatic', uuid.uuid4()),
        ).fetchone()[0]
        self.assertTrue(outcome['should_send'], outcome)
        self.assertEqual(self.c.execute("select count(*) from lifecycle_email_dispatches where booking_id=%s and status='queued'", (self.booking,)).fetchone()[0], 1)

    def test_abandoned_checkout_is_not_an_attestable_lifecycle_template(self):
        with self.assertRaises(psycopg.Error):
            self.record(**{'2': 'abandoned_checkout_1'})

    def test_post_trip_attestation_is_recordable_but_not_claimed_by_this_dispatcher(self):
        result = self.c.execute(
            'select public.record_external_email_attestation(%s,%s,%s,%s,%s,%s)',
            (self.project, self.ref, 'post_trip_followup', self.sent, 'Sent from Gmail', self.key),
        ).fetchone()[0]
        self.assertEqual(result['outcome'], 'recorded')
        with self.assertRaises(psycopg.Error):
            self.c.execute(
                "select public.claim_lifecycle_email_dispatch(%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp())",
                (self.booking, self.customer, 'post_trip_followup', 'synthetic@example.invalid', 'automatic subject', '', 'automatic', uuid.uuid4()),
            )

    def test_idempotency_payload_conflict(self):
        self.record()
        with self.assertRaises(psycopg.Error): self.record(**{'4':'different note'})

    def test_scope_fails(self):
        with self.assertRaises(psycopg.Error): self.record(**{'0':uuid.uuid4()})

    def test_stale_automatic_preflight_cannot_claim_after_gmail_attestation(self):
        # The automatic sender may have read no sent state before Gmail was recorded.
        # Its RPC must inspect durable canonical email history after taking the booking lock.
        self.assertEqual(self.c.execute("select count(*) from email_events where booking_id=%s and status='sent'", (self.booking,)).fetchone()[0], 0)
        self.assertEqual(self.record()['outcome'], 'recorded')
        outcome = self.c.execute(
            "select public.claim_lifecycle_email_dispatch(%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp())",
            (self.booking, self.customer, 'preparation_packing', 'synthetic@example.invalid', 'automatic subject', '', 'automatic', uuid.uuid4()),
        ).fetchone()[0]
        self.assertFalse(outcome['should_send'], outcome)
        self.assertEqual(outcome['reason'], 'lifecycle_already_attested')
        self.assertEqual(self.c.execute("select count(*) from lifecycle_email_dispatches where booking_id=%s", (self.booking,)).fetchone()[0], 0)

    def test_cross_booking_key_reuse_is_allowed(self):
        other_customer = self.c.execute("insert into customers(first_name,last_name,email) values ('Other','Fixture',%s) returning id", (f'{uuid.uuid4()}@example.invalid',)).fetchone()[0]
        other_ref = f'ATTEST-{uuid.uuid4()}'
        other_booking = self.c.execute("insert into bookings(project_id,customer_id,public_reference,status,tour_date) values (%s,%s,%s,'confirmed','October 21 – 29, 2026') returning id", (self.project, other_customer, other_ref)).fetchone()[0]
        self.fixture_booking_ids.append(other_booking)
        self.fixture_customer_ids.append(other_customer)
        self.assertEqual(self.record()['outcome'], 'recorded')
        result = self.c.execute(
            'select public.record_external_email_attestation(%s,%s,%s,%s,%s,%s)',
            (self.project, other_ref, 'preparation_packing', self.sent, 'Sent from Gmail', self.key),
        ).fetchone()[0]
        self.assertEqual(result['outcome'], 'recorded')

    def test_audit_insert_failure_rolls_back_email_event(self):
        self.c.execute("""create function public.fixture_reject_attestation_audit() returns trigger language plpgsql as $$
          begin raise exception 'fixture audit failure'; end $$""")
        self.c.execute("create trigger fixture_reject_attestation_audit before insert on booking_events for each row execute function public.fixture_reject_attestation_audit()")
        try:
            with self.assertRaises(psycopg.Error):
                self.record()
            self.assertEqual(self.c.execute("select count(*) from email_events where booking_id=%s", (self.booking,)).fetchone()[0], 0)
            self.assertEqual(self.c.execute("select count(*) from booking_events where booking_id=%s", (self.booking,)).fetchone()[0], 0)
        finally:
            self.c.execute('drop trigger fixture_reject_attestation_audit on booking_events')
            self.c.execute('drop function public.fixture_reject_attestation_audit()')

    def test_anon_and_authenticated_cannot_execute_attestation_rpc(self):
        for role in ('anon', 'authenticated'):
            with self.subTest(role=role):
                c = psycopg.connect(DSN, autocommit=True)
                try:
                    c.execute('set role anon' if role == 'anon' else 'set role authenticated')
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        c.execute('select public.record_external_email_attestation(%s,%s,%s,%s,%s,%s)', (self.project, self.ref, 'packing_list', self.sent, 'note', str(uuid.uuid4())))
                finally:
                    c.close()

    def test_queued_event_blocks_record(self):
        self.c.execute("insert into email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status) values (%s,%s,'preparation_packing','synthetic@example.invalid','fixture','','fixture','queued')",(self.booking,self.customer))
        self.assertEqual(self.record()['outcome'],'dispatch_busy')

    def test_active_lease_blocks_record(self):
        self.c.execute("update bookings set lifecycle_email_token=%s,lifecycle_email_claimed_at=now() where id=%s",(str(uuid.uuid4()),self.booking))
        self.assertEqual(self.record()['outcome'],'dispatch_busy')

    def test_cancelled_booking_blocks_record(self):
        self.c.execute("update bookings set status='cancelled' where id=%s",(self.booking,))
        self.assertEqual(self.record()['outcome'],'booking_cancelled')

    def test_concurrent_retry_one_event(self):
        def worker():
            with connect() as c: return self.record(c)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:worker(),range(2)))
        self.assertEqual(sorted(x['outcome'] for x in results),['already_recorded','recorded'])
        self.assertEqual(results[0]['event_id'],results[1]['event_id'])

    def test_cancellation_lock_wait_is_observed(self):
        blocker=connect(); blocker.execute('begin')
        blocker.execute("select id from bookings where id=%s for update",(self.booking,))
        worker=connect(); pid=worker.info.backend_pid
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(self.record,worker)
            deadline=time.monotonic()+5
            observed=False
            while time.monotonic()<deadline:
                row=self.c.execute('select wait_event_type from pg_stat_activity where pid=%s',(pid,)).fetchone()
                if row and row[0]=='Lock': observed=True; break
                time.sleep(.02)
            blocker.execute("update bookings set status='cancelled' where id=%s",(self.booking,)); blocker.execute('commit')
            self.assertTrue(observed,'did not observe real PostgreSQL lock wait')
            self.assertEqual(future.result(timeout=5)['outcome'],'booking_cancelled')
        blocker.close(); worker.close()

if __name__=='__main__': unittest.main(verbosity=2)

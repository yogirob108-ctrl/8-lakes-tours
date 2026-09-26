// GA4 session attribution for payment_received — RED/GREEN against the real webhook handler.
// Only database transport, email, and the GA4 HTTP boundary are replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as matching from '../lib/stripe-payment-match.mjs';

const GA4_SENT = 'GA4 payment_received event sent';
const GA4_SKIPPED = 'GA4 payment_received event skipped';

function buildHarness({ ga4Responses = [], ga4ApiSecret = 'ga4-secret', notes = 'GA client ID: 111222.333444\nGA session ID: 1785492000\nOther note', payment = null, legacyEvents = [] } = {}) {
  const booking = {
    id: 'b1', customer_id: 'c1', public_reference: '8L-TESTREF', status: 'awaiting_payment',
    tour_date: 'Scheduled', guest_count: 2, online_due_usd: 2922, online_paid_usd: 0,
    notes, customer: [{ first_name: 'Test', last_name: 'Guest', email: 'test@example.invalid' }],
  };
  const paymentRow = payment ?? {
    id: 'p1', booking_id: 'b1', amount_usd: 2922, status: 'pending',
    stripe_checkout_session_id: 'cs_test', stripe_payment_intent_id: 'pi_test',
    raw_event: {}, paid_at: null, refunded_at: null,
  };
  const rows = { bookings: [booking], payments: [paymentRow], booking_events: [...legacyEvents], email_events: [], payment_confirmation_dispatch: [] };
  let writes = 0;
  let uuidCounter = 0;
  const nextUuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
  let ga4Calls = 0;
  const sentEmails = [];
  const logs = { warn: [], error: [], info: [] };
  const db = {
    rpc: async (name, args) => {
      if (name === 'reconcile_paid_booking_v2') { booking.online_paid_usd = 2922; return { data: 2922 }; }
      if (name === 'confirm_paid_booking_v2') { booking.status = 'confirmed'; booking.payment_confirmation_token = args.p_token; return { data: { allowed: true } }; }
      if (name === 'authorize_payment_dispatch_v3') return { data: true };
      throw Error(name);
    },
    from(table) {
      let filters = []; let mutation = null; let single = false;
      const q = {
        select() { return q; },
        eq(k, v) { filters.push(r => k.startsWith('raw_event->>') ? r.raw_event[k.slice(12)] === v : r[k] === v); return q; },
        is(k, v) { filters.push(r => k.startsWith('raw_event->>') ? (r.raw_event[k.slice(12)] ?? null) === v : (r[k] ?? null) === v); return q; },
        in(k, vs) { filters.push(r => vs.includes(r[k])); return q; },
        contains(k, v) { filters.push(r => Object.entries(v).every(([a, b]) => r[k]?.[a] === b)); return q; },
        limit() { return q; },
        single() { single = true; return q; },
        maybeSingle() { single = true; return q; },
        update(v) { mutation = ['update', v]; return q; },
        insert(v) { mutation = ['insert', v]; return q; },
        then(resolve) {
          let found = rows[table].filter(r => filters.every(f => f(r)));
          if (mutation) {
            writes += 1;
            if (mutation[0] === 'insert') {
              const row = { id: `evt-${table}-${++writes}`, ...mutation[1] };
              rows[table].push(row); found = [row];
            } else {
              for (const r of found) Object.assign(r, mutation[1]);
            }
          }
          resolve({ data: single ? (found[0] ?? null) : found, error: null });
        },
      };
      return q;
    },
  };
  const fetchLog = [];
  const fetchImpl = async (url, options) => {
    ga4Calls += 1;
    fetchLog.push({ url: String(url), body: JSON.parse(options?.body ?? '{}') });
    const response = ga4Responses.length > 1 ? ga4Responses.shift() : ga4Responses[0];
    if (response instanceof Error) throw response;
    return response;
  };
  const code = readFileSync(new URL('../app/api/stripe/webhook/route.ts', import.meta.url), 'utf8')
    + '\nexport {handleCheckoutSessionPaid};';
  const exports = {};
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    process: { env: ga4ApiSecret ? { GA4_MEASUREMENT_API_SECRET: ga4ApiSecret } : {} },
    crypto: { randomUUID: nextUuid },
    fetch: fetchImpl,
    setTimeout,
    console: {
      info: (...a) => logs.info.push(a),
      warn: (...a) => logs.warn.push(a),
      error: (...a) => logs.error.push(a),
    },
    require(name) {
      if (name === 'stripe') return { default: class { } };
      if (name === 'next/server') return { NextResponse: { json: (body, init) => ({ body, ...init }) } };
      if (name === '@/lib/supabase-admin') return { createSupabaseAdminClient: () => db };
      if (name === '@/lib/ops-config') return { isSupabaseAdminConfigured: true };
      if (name === '@/lib/stripe-payment-match.mjs') return matching;
      if (name === '@/lib/tour-booking.mjs') return { canAutomaticallyConfirmBooking: () => true };
      if (name === '@/lib/email') return {
        getInternalEmailRecipients: () => ['ops@example.invalid'],
        paymentConfirmedCustomerEmail: () => ({ subject: 'Payment confirmed', text: 'Paid', html: 'Paid' }),
        paymentReceivedInternalEmail: () => ({ subject: 'Internal payment', text: 'Paid', html: 'Paid' }),
        sendEmail: async input => { sentEmails.push(input); return { sent: true, id: 'resend-1' }; },
      };
      return {};
    },
  });
  const session = {
    id: 'cs_test', payment_status: 'paid', amount_total: 292200, currency: 'usd',
    payment_intent: 'pi_test', client_reference_id: '8L-TESTREF',
    metadata: { booking_id: 'b1', customer_id: 'c1', guest_count: '2' },
  };
  return {
    rows, booking, fetchLog, sentEmails, logs,
    ga4CallsSoFar: () => ga4Calls,
    run: () => exports.handleCheckoutSessionPaid(session),
  };
}

const gaEvents = rows => rows.booking_events.filter(e => e.title === GA4_SENT || e.title === GA4_SKIPPED);
const legacyPayment = () => ({
  id: 'p1', booking_id: 'b1', amount_usd: 2922, status: 'paid',
  stripe_checkout_session_id: 'cs_test', stripe_payment_intent_id: 'pi_test',
  raw_event: { processing_complete: true, processing_completed_at: '2026-09-15T00:00:00Z' },
  paid_at: '2026-09-15T00:00:00Z', refunded_at: null,
});
const legacySkipRow = () => ({
  id: 'legacy-skip', booking_id: 'b1', title: GA4_SKIPPED,
  body: 'Reason: ga4_http_503', metadata: { stripe_checkout_session_id: 'cs_test' },
});

test('ga4 payment payload carries the captured ga session id for session attribution', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: true, status: 204 }] });
  await h.run();
  assert.equal(h.fetchLog.length, 1);
  const event = h.fetchLog[0].body.events[0];
  assert.equal(event.params.session_id, '1785492000', 'MP session attribution requires the session_id event parameter (official use-case requirement)');
  const serialized = JSON.stringify(h.fetchLog[0].body);
  assert.ok(!serialized.includes('cs_test'), 'stripe session id must still never reach GA4');
});

test('ga4 payment payload omits session_id cleanly when the booking has no captured session id', async () => {
  const h = buildHarness({
    ga4Responses: [{ ok: true, status: 204 }],
    notes: 'GA client ID: 111222.333444\nOther note',
  });
  await h.run();
  const event = h.fetchLog[0].body.events[0];
  assert.equal(event.params.session_id, undefined, 'no invented or defaulted session id may be sent');
});

test('ga4 payment payload never invents engagement time or session-scoped timestamps', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: true, status: 204 }] });
  await h.run();
  const event = h.fetchLog[0].body.events[0];
  assert.equal(event.params.engagement_time_msec, undefined, 'engagement time must not be fabricated');
  assert.equal(h.fetchLog[0].body.timestamp_micros, undefined, 'request timestamp must not be overridden without a defensible in-session value');
  assert.equal(event.timestamp_micros, undefined, 'event timestamp must not be overridden without a defensible in-session value');
});

test('ga session id is a permitted booking attribution field that survives normalization', async () => {
  const mod = await import('../lib/public-booking.mjs');
  const result = mod.normalizePublicBookingPayload({
    submission_key: '11111111-2222-4333-8444-555555555555',
    tour_date: 'Scheduled',
    guest_count: 1,
    emergency_contact: '',
    how_heard: '',
    notes: '',
    signature: 'Test Guest',
    waiver_agreed: 'on',
    travellers: [{ position: 1, is_lead: true, first_name: 'Test', last_name: 'Guest', email: 'lead@example.invalid', phone: null, nationality: 'US', gender: 'Female', date_of_birth: '1990-01-01', riding_experience: 'Intermediate — comfortable riding', dietary_notes: null }],
    attribution: { ga_client_id: '111222.333444', ga_session_id: '1785492000', email: 'nope@example.invalid' },
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.attribution.ga_session_id, '1785492000');
  assert.equal(result.value.attribution.email, undefined, 'PII stays rejected from attribution');
});

test('attribution notes label the ga session id for the webhook to read', async () => {
  const source = readFileSync(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8');
  assert.match(source, /ga_session_id/, 'bookings route must carry a GA session ID attribution label');
});

// ------------------------- existing retry/privacy suite -------------------------

test('ga4 non-ok response does not write a terminal skip record and throws so Stripe retries', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: false, status: 503 }] });
  await assert.rejects(() => h.run(), /GA4 payment event send failed/);
  assert.equal(gaEvents(h.rows).length, 0, 'no skipped/sent GA4 record may be written on a retryable failure');
  assert.equal(h.rows.bookings[0].status, 'confirmed');
});

test('failure then replay after ga4 recovers sends exactly one payment_received event', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: false, status: 500 }, { ok: true, status: 204 }] });
  await assert.rejects(() => h.run());
  // A real Stripe redelivery arrives after the abandoned processing lease has
  // expired; backdate it instead of waiting out the 10-minute window.
  h.rows.payments[0].raw_event.processing_claimed_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await h.run();
  const sent = h.rows.booking_events.filter(e => e.title === GA4_SENT);
  assert.equal(sent.length, 1);
  assert.equal(h.ga4CallsSoFar(), 2);
  const customerEmails = h.sentEmails.filter(e => e.to === 'test@example.invalid');
  const internalEmails = h.sentEmails.filter(e => Array.isArray(e.to));
  assert.equal(customerEmails.length, 1, 'customer confirmation email sent once');
  assert.equal(internalEmails.length, 1, 'internal notification sent once');
  assert.equal(h.rows.payments[0].raw_event.processing_complete, true);
});

test('three further replays after recovery stay one ga4 event, one of each email, one payment row', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: false, status: 502 }, { ok: true, status: 204 }] });
  await assert.rejects(() => h.run());
  h.rows.payments[0].raw_event.processing_claimed_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await h.run();
  for (let replay = 0; replay < 3; replay += 1) await h.run();
  assert.equal(gaEvents(h.rows).filter(e => e.title === GA4_SENT).length, 1, 'exactly one sent record after four total runs');
  assert.equal(h.ga4CallsSoFar(), 2, 'no ga4 fetch after recovery converged');
  assert.equal(h.sentEmails.filter(e => e.to === 'test@example.invalid').length, 1);
  assert.equal(h.sentEmails.filter(e => Array.isArray(e.to)).length, 1);
  assert.equal(h.rows.payments.length, 1, 'no duplicate payment row');
  assert.equal(h.rows.payments[0].raw_event.processing_complete, true);
});

test('multiple historical ga4 rows: a sent row wins regardless of row order and blocks a re-send', async () => {
  for (const firstRow of [GA4_SKIPPED, GA4_SENT]) {
    const secondRow = firstRow === GA4_SKIPPED ? GA4_SENT : GA4_SKIPPED;
    const h = buildHarness({
      ga4Responses: [{ ok: true, status: 204 }],
      legacyEvents: [
        { id: 'legacy-a', booking_id: 'b1', title: firstRow, body: firstRow === GA4_SKIPPED ? 'Reason: ga4_http_503' : 'sent', metadata: { stripe_checkout_session_id: 'cs_test' } },
        { id: 'legacy-b', booking_id: 'b1', title: secondRow, body: secondRow === GA4_SKIPPED ? 'Reason: ga4_http_503' : 'sent', metadata: { stripe_checkout_session_id: 'cs_test' } },
      ],
    });
    await h.run();
    assert.equal(h.ga4CallsSoFar(), 0, `sent row must win when stored first (${firstRow} first)`);
    assert.equal(gaEvents(h.rows).filter(e => e.title === GA4_SENT).length, 1);
  }
});

test('replay after payment already processed recovers a missed ga4 event (no universal dedupe block)', async () => {
  // Legacy state: payment terminal-complete while GA4 was only recorded as skipped.
  const h = buildHarness({
    payment: legacyPayment(),
    ga4Responses: [{ ok: true, status: 204 }],
  });
  h.rows.booking_events.push(legacySkipRow());
  await h.run();
  assert.ok(h.ga4CallsSoFar() >= 1, 'ga4 must be retried even when payment processing is already complete');
  assert.ok(h.rows.booking_events.some(e => e.title === GA4_SENT));
});

test('recovery updates the legacy skip row to sent instead of adding a duplicate ga4 row', async () => {
  const h = buildHarness({
    payment: legacyPayment(),
    ga4Responses: [{ ok: true, status: 204 }],
  });
  h.rows.booking_events.push(legacySkipRow());
  await h.run();
  const ga4Rows = gaEvents(h.rows);
  assert.equal(ga4Rows.length, 1, 'repair must reuse the legacy row, not add a second');
  assert.equal(ga4Rows[0].title, GA4_SENT);
});

test('recovery keeps a permanent legacy skip (missing client id) without resending', async () => {
  const h = buildHarness({
    payment: legacyPayment(),
    notes: 'No GA marker in these notes',
  });
  h.rows.booking_events.push({
    id: 'legacy-skip', booking_id: 'b1', title: GA4_SKIPPED,
    body: 'Reason: missing_ga4_client_id', metadata: { stripe_checkout_session_id: 'cs_test', reason: 'missing_ga4_client_id' },
  });
  await h.run();
  assert.equal(h.ga4CallsSoFar(), 0, 'permanent skip must not be retried');
  assert.equal(gaEvents(h.rows).length, 1);
  assert.equal(gaEvents(h.rows)[0].title, GA4_SKIPPED);
});

test('recovery replay leaves the recorded payment and booking state untouched', async () => {
  const h = buildHarness({
    payment: legacyPayment(),
    ga4Responses: [{ ok: true, status: 204 }],
  });
  h.rows.booking_events.push(legacySkipRow());
  await h.run();
  assert.equal(h.rows.payments.length, 1, 'no second payment row');
  assert.equal(h.rows.payments[0].status, 'paid');
  assert.equal(h.rows.payments[0].raw_event.processing_complete, true);
  assert.equal(h.rows.bookings[0].status, 'awaiting_payment', 'recovery must not confirm the booking');
  assert.equal(h.sentEmails.length, 0, 'recovery must not re-send customer or internal emails');
});

test('refunded complete replay emits no fresh ga4 conversion', async () => {
  const h = buildHarness({
    payment: { ...legacyPayment(), status: 'refunded', refunded_at: '2026-09-15T01:00:00Z' },
    ga4Responses: [{ ok: true, status: 204 }],
  });
  h.rows.booking_events.push(legacySkipRow());
  await h.run();
  assert.equal(h.ga4CallsSoFar(), 0, 'a refunded purchase must not emit a marketing conversion');
});

test('duplicate webhook after success sends no extra payment email or ga4 event', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: true, status: 204 }] });
  await h.run();
  const callsAfterFirst = h.ga4CallsSoFar();
  const emailsAfterFirst = h.sentEmails.length;
  const paymentsAfterFirst = h.rows.payments.length;
  await h.run();
  assert.equal(h.ga4CallsSoFar(), callsAfterFirst, 'no extra GA4 fetch');
  assert.equal(h.sentEmails.length, emailsAfterFirst, 'no extra customer email');
  assert.equal(h.rows.payments.length, paymentsAfterFirst, 'no extra payment row');
  assert.equal(h.rows.booking_events.filter(e => e.title === GA4_SENT).length, 1);
});

test('missing ga4 config skips without network call, records reason, and never blocks processing', async () => {
  const h = buildHarness({ ga4ApiSecret: '' });
  await h.run();
  assert.equal(h.ga4CallsSoFar(), 0);
  const skipped = h.rows.booking_events.filter(e => e.title === GA4_SKIPPED);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].metadata.reason, 'missing_ga4_config');
  assert.equal(h.rows.payments[0].raw_event.processing_complete, true);
  await h.run();
  assert.equal(h.rows.booking_events.filter(e => e.title === GA4_SKIPPED).length, 1, 'no duplicate skip rows on replay');
});

test('missing ga4 client id skips permanently without network call', async () => {
  const h = buildHarness({ notes: 'No GA marker in these notes' });
  await h.run();
  assert.equal(h.ga4CallsSoFar(), 0);
  const skipped = h.rows.booking_events.filter(e => e.title === GA4_SKIPPED);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].metadata.reason, 'missing_ga4_client_id');
  assert.equal(h.rows.payments[0].raw_event.processing_complete, true);
});

test('ga4 payload carries no raw booking reference or provider session id, denies ads consent, and persists a non-linkable event id', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: true, status: 204 }] });
  await h.run();
  assert.equal(h.fetchLog.length, 1);
  const event = h.fetchLog[0].body.events[0];
  assert.equal(event.name, 'payment_received');
  assert.equal(event.params.value, 2922);
  assert.equal(event.params.currency, 'USD');
  const serialized = JSON.stringify(h.fetchLog[0].body);
  assert.ok(!/@/.test(serialized), 'no email address in ga4 payload');
  assert.ok(!serialized.includes('8L-TESTREF'), 'raw booking reference must not be sent to GA4');
  assert.ok(!serialized.includes('cs_test'), 'stripe session id must not be sent to GA4');
  assert.ok(!/^stripe_/.test(String(event.params.event_id || '')), 'event id must not embed the provider id');
  assert.match(String(event.params.event_id || ''), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'event id must be a random non-linkable uuid');
  assert.equal(h.fetchLog[0].body.consent?.ad_user_data, 'DENIED', 'MP requires the DENIED string for ad_user_data');
  assert.equal(h.fetchLog[0].body.consent?.ad_personalization, 'DENIED', 'MP requires the DENIED string for ad_personalization');
  const sentRow = h.rows.booking_events.find(e => e.title === GA4_SENT);
  assert.equal(sentRow?.metadata?.ga4_event_id, event.params.event_id, 'the sent identifier must be persisted on the timeline row');
});

test('ga4 network failure logs never expose the request url or api secret', async () => {
  const h = buildHarness({
    ga4Responses: [new Error('fetch failed: https://www.google-analytics.com/mp/collect?measurement_id=G-X&api_secret=super-secret-value')],
  });
  await assert.rejects(() => h.run());
  const serializedLogs = JSON.stringify([...h.logs.warn, ...h.logs.error, ...h.logs.info]);
  assert.ok(!serializedLogs.includes('super-secret-value'), 'api secret must never reach logs');
  assert.ok(!serializedLogs.includes('google-analytics.com'), 'full request url must never reach logs');
});

test('unpaid booking_form_submit funnel event carries no monetized value or currency', async () => {
  const source = readFileSync(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8');
  const start = source.indexOf("trackFunnelEvent('booking_form_submit'");
  assert.ok(start > 0, 'booking_form_submit tracking call exists');
  const end = source.indexOf('});', start);
  const call = source.slice(start, end);
  assert.ok(!/value:/.test(call), 'unpaid booking_form_submit must not send a monetary value');
  assert.ok(!/currency:/.test(call), 'unpaid booking_form_submit must not send currency');
  const clickStart = source.indexOf("trackFunnelEvent('stripe_payment_click'");
  const clickEnd = source.indexOf('});', clickStart);
  const clickCall = source.slice(clickStart, clickEnd);
  assert.ok(/value:/.test(clickCall) && /currency:/.test(clickCall), 'genuine payment click keeps monetized semantics');
});

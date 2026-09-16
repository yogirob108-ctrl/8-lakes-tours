// GA4 payment_received retry repair — RED/GREEN against the real webhook handler.
// Only database transport, email, and the GA4 HTTP boundary are replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as matching from '../lib/stripe-payment-match.mjs';

const GA4_SENT = 'GA4 payment_received event sent';
const GA4_SKIPPED = 'GA4 payment_received event skipped';

function buildHarness({ ga4Responses = [], ga4ApiSecret = 'ga4-secret', notes = 'GA client ID: 111222.333444\nOther note', payment = null } = {}) {
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
  const rows = { bookings: [booking], payments: [paymentRow], booking_events: [], email_events: [], payment_confirmation_dispatch: [] };
  let writes = 0;
  let ga4Calls = 0;
  const sentEmails = [];
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
    crypto: { randomUUID: () => 'token-' + (++writes) },
    fetch: fetchImpl,
    setTimeout,
    console: { info() {}, warn() {}, error() {} },
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
    rows, booking, fetchLog, sentEmails,
    ga4CallsSoFar: () => ga4Calls,
    run: () => exports.handleCheckoutSessionPaid(session),
  };
}

const gaEvents = rows => rows.booking_events.filter(e => e.title === GA4_SENT || e.title === GA4_SKIPPED);

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

test('replay after payment already processed recovers a missed ga4 event (no universal dedupe block)', async () => {
  // Legacy state: payment terminal-complete while GA4 was only recorded as skipped.
  const h = buildHarness({
    payment: {
      id: 'p1', booking_id: 'b1', amount_usd: 2922, status: 'paid',
      stripe_checkout_session_id: 'cs_test', stripe_payment_intent_id: 'pi_test',
      raw_event: { processing_complete: true, processing_completed_at: '2026-09-15T00:00:00Z' },
      paid_at: '2026-09-15T00:00:00Z', refunded_at: null,
    },
    ga4Responses: [{ ok: true, status: 204 }],
  });
  h.rows.booking_events.push({
    id: 'legacy-skip', booking_id: 'b1', title: GA4_SKIPPED,
    body: 'Reason: ga4_http_503', metadata: { stripe_checkout_session_id: 'cs_test' },
  });
  await h.run();
  assert.ok(h.ga4CallsSoFar() >= 1, 'ga4 must be retried even when payment processing is already complete');
  assert.ok(h.rows.booking_events.some(e => e.title === GA4_SENT));
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

test('ga4 payload stays privacy-safe and carries event identifier', async () => {
  const h = buildHarness({ ga4Responses: [{ ok: true, status: 204 }] });
  await h.run();
  assert.equal(h.fetchLog.length, 1);
  const event = h.fetchLog[0].body.events[0];
  assert.equal(event.name, 'payment_received');
  assert.equal(event.params.event_id, 'stripe_cs_test');
  assert.equal(event.params.value, 2922);
  assert.equal(event.params.currency, 'USD');
  const serialized = JSON.stringify(h.fetchLog[0].body);
  assert.ok(!/@/.test(serialized), 'no email address in ga4 payload');
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

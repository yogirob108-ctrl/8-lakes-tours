import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as matching from '../lib/stripe-payment-match.mjs';

const booking = { id: 'booking', customer_id: 'customer', public_reference: '8L-REFERENCE', guest_count: 3, submission_key: 'submission', online_due_usd: 2847 };
const payment = { id: 'payment', booking_id: booking.id, amount_usd: 2847, stripe_checkout_session_id: 'cs_fixture', stripe_payment_intent_id: null, status: 'pending', raw_event: { checkout_issuance: { expected: { guest_count: 3 } } } };
const session = { id: 'cs_fixture', payment_status: 'paid', amount_total: 284700, currency: 'usd', payment_intent: 'pi_fixture', client_reference_id: booking.public_reference, metadata: { booking_id: booking.id, customer_id: booking.customer_id, guest_count: '3' } };
function handler(paymentRow = payment, bookingRow = booking) {
  let writes = 0;
  const db = { from(table) { return { select() { return this; }, eq(column, value) { this.column = column; this.value = value; return this; }, in() { return this; }, contains() { return this; }, limit() { return this; }, async maybeSingle() { return { data: table === 'payments' ? paymentRow : table === 'bookings' ? bookingRow : null }; }, update() { writes++; throw new Error('write attempted'); }, insert() { writes++; throw new Error('write attempted'); } }; } };
  const exports = {};
  const source = readFileSync(new URL('../app/api/stripe/webhook/route.ts', import.meta.url), 'utf8') + '\nexport { handleCheckoutSessionPaid };';
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, process: { env: {} }, crypto: { randomUUID: () => 'token' }, console: { info() {}, warn() {} }, require(name) {
    if (name === 'stripe') return { default: class {} };
    if (name === 'next/server') return {};
    if (name === '@/lib/ops-config') return { isSupabaseAdminConfigured: true };
    if (name === '@/lib/supabase-admin') return { createSupabaseAdminClient: () => db };
    if (name === '@/lib/stripe-payment-match.mjs') return matching;
    if (name === '@/lib/email') return {};
    if (name === '@/lib/tour-booking.mjs') return { canAutomaticallyConfirmBooking: () => true };
    throw new Error(name);
  } });
  return { run: exports.handleCheckoutSessionPaid, writes: () => writes };
}
for (const [name, change] of [
  ['missing paid status', { payment_status: undefined }],
  ['underpayment', { amount_total: 99900 }],
  ['overpayment', { amount_total: 284701 }],
  ['fractional cents', { amount_total: 284700.1 }],
  ['conflicting public reference metadata', { metadata: { ...session.metadata, public_reference: '8L-OTHER' } }],
  ['nonliteral client reference', { client_reference_id: ' '+session.client_reference_id }],
  ['conflicting reference metadata', { metadata: { ...session.metadata, booking_reference: '8L-OTHER' } }],
  ['conflicting booking metadata', { metadata: { ...session.metadata, booking_id: 'other' } }],
  ['conflicting customer metadata', { metadata: { ...session.metadata, customer_id: 'other' } }],
  ['conflicting manifest metadata', { metadata: { ...session.metadata, guest_count: '2' } }],
]) test(`actual paid webhook rejects ${name} before mutation`, async () => {
  const route = handler();
  const result = await route.run({ ...session, ...change });
  assert.equal(result.matched, false);
  assert.equal(route.writes(), 0);
});
for (const [field, value] of [['stripe_checkout_session_id', 'cs_other'], ['stripe_payment_intent_id', 'pi_other']]) {
  test(`actual paid webhook rejects conflicting ledger ${field}`, async () => {
    const route = handler({ ...payment, [field]: value });
    assert.equal((await route.run(session)).matched, false);
    assert.equal(route.writes(), 0);
  });
}
for (const status of ['paid', 'partially_refunded', 'refunded']) {
  test(`valid ${status} replay retains frozen ledger amount despite changed booking due`, async () => {
    const route = handler({ ...payment, status, raw_event: { processing_complete: true } }, { ...booking, online_due_usd: 999 });
    assert.equal((await route.run(session)).matched, true);
    assert.equal(route.writes(), 0);
  });
}

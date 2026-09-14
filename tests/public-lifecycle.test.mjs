import test from 'node:test';
import assert from 'node:assert/strict';
import { getDryRun, selectPacedLifecycleCandidate, reconcileStripeProviderEvidence } from '../lib/public-lifecycle.mjs';

const booking = { id: 'b1', reference: '8L-ABC123', amount_cents: 99900, currency: 'usd', customer_email: 'davide@example.test' };
const paidSession = {
  source: 'checkout_session', id: 'cs_paid', reference: '8L-ABC123', amount_cents: 99900, currency: 'usd',
  customer_email: 'davide@example.test', checkout_status: 'complete', payment_status: 'paid',
  payment_intent_status: 'succeeded', charge_amount_cents: 99900, charge_amount_refunded_cents: 0,
};

function one(evidence, scanComplete = true) {
  return reconcileStripeProviderEvidence({ bookings: [booking], evidence, scanComplete })[0];
}

test('only explicit dry_run and dryRun query spellings enable a reconciliation dry run', () => {
  assert.equal(getDryRun(new URL('https://example.test/api?dry_run=1')), true);
  assert.equal(getDryRun(new URL('https://example.test/api?dryRun=1')), true);
  assert.equal(getDryRun(new URL('https://example.test/api?dryrun=1')), false);
  assert.equal(getDryRun(new URL('https://example.test/api?dry_run=true')), false);
});

test('reconciliation verifies only an exact fully funded completed paid Checkout session', () => {
  assert.deepEqual(one([paidSession]), {
    reference: '8L-ABC123', status: 'verified_paid', stripe_reference: 'cs_paid', source: 'checkout_session',
  });
});

test('reconciliation requires exact current amount, currency, and customer identity', () => {
  assert.equal(one([{ ...paidSession, amount_cents: 99899 }]).status, 'review_amount_mismatch');
  assert.equal(one([{ ...paidSession, currency: 'eur' }]).status, 'review_currency_mismatch');
  assert.equal(one([{ ...paidSession, customer_email: 'other@example.test' }]).status, 'review_customer_mismatch');
});

test('reconciliation makes refunded and partial funding evidence review-only', () => {
  assert.equal(one([{ ...paidSession, charge_amount_refunded_cents: 1 }]).status, 'review_refunded_or_partial');
  assert.equal(one([{ ...paidSession, charge_amount_cents: 50000 }]).status, 'review_refunded_or_partial');
});

test('reconciliation rejects incomplete Checkout and non-successful payment intent evidence', () => {
  assert.equal(one([{ ...paidSession, checkout_status: 'open' }]).status, 'review_payment_not_complete');
  assert.equal(one([{ ...paidSession, payment_status: 'unpaid' }]).status, 'review_payment_not_complete');
  assert.equal(one([{ ...paidSession, payment_intent_status: 'processing' }]).status, 'review_payment_not_complete');
});

test('reconciliation accepts exactly bound PaymentIntent and Invoice evidence but never ambiguous matches', () => {
  const paymentIntent = { ...paidSession, source: 'payment_intent', id: 'pi_paid', checkout_status: undefined };
  assert.equal(one([paymentIntent]).status, 'verified_paid');
  const invoice = { ...paidSession, source: 'invoice', id: 'in_paid', checkout_status: undefined };
  assert.equal(one([invoice]).status, 'verified_paid');
  assert.equal(one([{ ...paidSession }, { ...paidSession, id: 'cs_second' }]).status, 'review_multiple_conflicting_matches');
});

test('reconciliation returns unknown rather than no payment when a bounded provider scan is incomplete', () => {
  assert.deepEqual(one([], false), { reference: '8L-ABC123', status: 'scan_incomplete_unknown' });
  assert.deepEqual(one([paidSession], false), { reference: '8L-ABC123', status: 'scan_incomplete_unknown' });
});

test('reconciliation preserves historical provider payment evidence but does not call changed terms funded', () => {
  const changed = { ...booking, amount_cents: 109900 };
  assert.deepEqual(reconcileStripeProviderEvidence({ bookings: [changed], evidence: [paidSession], scanComplete: true }), [{
    reference: '8L-ABC123', status: 'review_amount_mismatch', historical_provider_payment: { stripe_reference: 'cs_paid', source: 'checkout_session' },
  }]);
});

test('catchup selects one earliest missing useful lifecycle email per booking', () => {
  const candidate = selectPacedLifecycleCandidate({ verifiedStripe: true, daysUntilDeparture: 10, sentTemplates: new Set(['payment_confirmed']) });
  assert.equal(candidate, 'preparation_packing');
  assert.equal(selectPacedLifecycleCandidate({ verifiedStripe: false, daysUntilDeparture: 10, sentTemplates: new Set() }), null);
  assert.equal(selectPacedLifecycleCandidate({ verifiedStripe: true, daysUntilDeparture: -1, sentTemplates: new Set() }), null);
});

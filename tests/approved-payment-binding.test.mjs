import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStripeProviderEvidence } from '../lib/public-lifecycle.mjs';

// Exact live-shape evidence for booking 8L-GDFH3 (Sanitized: no customer PII).
const booking = { id: 'b1', reference: '8L-GDFH3', amount_cents: 99900, currency: 'usd', customer_email: 'davide@example.test' };
const openCheckout = {
  source: 'checkout_session', id: 'cs_open', reference: '8L-GDFH3', amount_cents: 99900, currency: 'usd',
  customer_email: 'davide@example.test', checkout_status: 'open', payment_status: 'unpaid',
  payment_intent_status: undefined, charge_amount_cents: undefined, charge_amount_refunded_cents: 0,
};
const canceledCheckout = (id, intentId) => ({
  source: 'checkout_session', id, reference: '8L-GDFH3', amount_cents: 99900, currency: 'usd',
  customer_email: 'davide@example.test', checkout_status: 'expired', payment_status: 'unpaid',
  payment_intent_id: intentId, payment_intent_status: 'canceled', charge_amount_cents: 99900, charge_amount_refunded_cents: 0,
});
const paidInvoice = {
  source: 'invoice', id: 'in_1UF8Z03OYuYvjeqEXk3sNFbD', reference: undefined, payment_intent_id: 'pi_canonical',
  amount_cents: 99900, currency: 'usd', customer_email: 'davide@example.test', checkout_status: undefined,
  payment_status: 'paid', payment_intent_status: 'succeeded', charge_amount_cents: 99900, charge_amount_refunded_cents: 0,
};
const binding = { booking_id: 'b1', provider: 'stripe', provider_object_id: 'in_1UF8Z03OYuYvjeqEXk3sNFbD' };

function run(evidence, approvedBindings, extra = {}) {
  return reconcileStripeProviderEvidence({
    bookings: [booking], evidence, approvedBindings, scanComplete: true, ...extra,
  })[0];
}

test('an approved binding verifies the exact bound provider payment when reference matches conflict', () => {
  const result = run([openCheckout, canceledCheckout('cs_x', 'pi_x'), canceledCheckout('cs_y', 'pi_y'), paidInvoice], [binding]);
  assert.deepEqual(result, {
    reference: '8L-GDFH3', status: 'verified_paid', stripe_reference: 'pi_canonical',
    source: 'invoice', bound_provider_object: 'in_1UF8Z03OYuYvjeqEXk3sNFbD', bound_via_approved_binding: true,
  });
});

test('a binding never overrides current-term evidence gates', () => {
  assert.equal(run([paidInvoice], [binding], { bookings: [{ ...booking, amount_cents: 109900 }] }).status, 'review_amount_mismatch');
  assert.equal(run([{ ...paidInvoice, currency: 'eur' }], [binding]).status, 'review_currency_mismatch');
  assert.equal(run([{ ...paidInvoice, customer_email: 'other@example.test' }], [binding]).status, 'review_customer_mismatch');
  assert.equal(run([{ ...paidInvoice, payment_intent_status: 'canceled' }], [binding]).status, 'review_payment_not_complete');
  assert.equal(run([{ ...paidInvoice, charge_amount_refunded_cents: 1 }], [binding]).status, 'review_refunded_or_partial');
});

test('a binding fails closed when the bound object is absent or duplicated', () => {
  assert.deepEqual(run([openCheckout, canceledCheckout('cs_x', 'pi_x')], [binding]), {
    reference: '8L-GDFH3', status: 'review_binding_object_missing', bound_provider_object: 'in_1UF8Z03OYuYvjeqEXk3sNFbD',
  });
  assert.equal(run([], [binding], { scanComplete: false, scanIncompleteReason: 'provider_collection_unavailable', scanIncompleteCollection: 'invoice' }).status, 'scan_incomplete_unknown');
  const two = run([paidInvoice, { ...paidInvoice, payment_intent_id: 'pi_other' }], [binding, { ...binding, provider_object_id: 'in_second' }]);
  assert.equal(two.status, 'review_multiple_bindings');
});

test('a paid invoice with no booking reference is verified through the binding', () => {
  // Dedup: same canonical PI observed via both the Invoice and the
  // PaymentIntent collection is ONE transaction, not a conflict.
  const result = run(
    [paidInvoice, { ...paidInvoice, source: 'payment_intent', id: 'pi_canonical' }],
    [binding],
  );
  assert.equal(result.status, 'verified_paid');
  assert.equal(result.stripe_reference, 'pi_canonical');
});

test('bindings for other bookings and legacy calls keep reconciliation unchanged', () => {
  const other = { ...binding, booking_id: 'b2' };
  const conflicted = run([openCheckout, canceledCheckout('cs_x', 'pi_x'), canceledCheckout('cs_y', 'pi_y')], [other]);
  assert.equal(conflicted.status, 'review_multiple_conflicting_matches');
  // Legacy callers that pass no bindings keep the exact pre-binding contract.
  const legacy = reconcileStripeProviderEvidence({ bookings: [booking], evidence: [], scanComplete: true });
  assert.equal(legacy[0].status, 'no_verified_payment');
  const legacyAmbiguous = reconcileStripeProviderEvidence({ bookings: [booking], evidence: [paidInvoice], scanComplete: true });
  assert.equal(legacyAmbiguous[0].status, 'review_ambiguous_unbound_evidence');
});

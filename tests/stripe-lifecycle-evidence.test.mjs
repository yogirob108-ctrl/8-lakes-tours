import test from 'node:test';
import assert from 'node:assert/strict';
import { collectStripeLifecycleEvidence } from '../lib/stripe-lifecycle-evidence.mjs';

test('collector explicitly paginates all provider collections and returns normalized Checkout, PaymentIntent, and Invoice evidence', async () => {
  const calls = [];
  const list = (kind) => async ({ starting_after }) => {
    calls.push(`${kind}:${starting_after || 'first'}`);
    if (!starting_after) return { data: [{ id: `${kind}_1`, client_reference_id: '8L-ABC123', metadata: { booking_reference: '8L-ABC123' }, amount_total: 99900, amount_received: 99900, currency: 'usd', customer_email: 'davide@example.test', status: kind === 'invoice' ? 'paid' : undefined, payment_status: kind === 'checkout' ? 'paid' : undefined, payment_intent: { id: 'pi_1', status: 'succeeded', latest_charge: { amount: 99900, amount_refunded: 0 } } }], has_more: true };
    return { data: [], has_more: false };
  };
  const result = await collectStripeLifecycleEvidence({ stripe: { checkout: { sessions: { list: list('checkout') } }, paymentIntents: { list: list('pi') }, invoices: { list: list('invoice') } }, pageBudget: 6 });
  assert.equal(result.scanComplete, true);
  assert.deepEqual(calls, ['checkout:first', 'checkout:checkout_1', 'pi:first', 'pi:pi_1', 'invoice:first', 'invoice:invoice_1']);
  assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.evidence.map(row => row.source), ['checkout_session', 'payment_intent', 'invoice']);
});

test('collector reports scan incomplete rather than silently returning no payment when its explicit page budget is exhausted', async () => {
  const endless = async () => ({ data: [{ id: 'next', amount: 99900, amount_received: 99900, currency: 'usd', status: 'succeeded', latest_charge: { amount: 99900, amount_refunded: 0 } }], has_more: true });
  const result = await collectStripeLifecycleEvidence({ stripe: { checkout: { sessions: { list: endless } }, paymentIntents: { list: endless }, invoices: { list: endless } }, pageBudget: 1 });
  assert.equal(result.scanComplete, false);
  assert.equal(result.scanIncompleteReason, 'page_budget_exhausted');
});

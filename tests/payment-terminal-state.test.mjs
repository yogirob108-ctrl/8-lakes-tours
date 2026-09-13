import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentProcessingDecision } from '../lib/stripe-payment-match.mjs';
for (const status of ['disputed', 'failed', 'cancelled', 'unknown']) {
  test(`paid replay never upgrades ${status} ledger state`, () => {
    assert.equal(paymentProcessingDecision({ status, amountUsd: 2847 }).process, false);
  });
}

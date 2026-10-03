import test from 'node:test';
import assert from 'node:assert/strict';
import { isPriceHoldActive } from '../lib/price-hold.mjs';

test('the price hold runs through 31 December in Hawaii and then ends', () => {
  assert.equal(isPriceHoldActive(new Date('2026-12-31T23:59:59-10:00')), true);
  assert.equal(isPriceHoldActive(new Date('2027-01-01T00:00:00-10:00')), false);
});

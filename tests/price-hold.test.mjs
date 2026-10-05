import test from 'node:test';
import assert from 'node:assert/strict';
import { isPriceHoldActive } from '../lib/price-hold.mjs';

test('the price hold runs through 31 December in Hawaii and then ends', () => {
  assert.equal(isPriceHoldActive(new Date('2026-12-31T23:59:59-10:00')), true);
  assert.equal(isPriceHoldActive(new Date('2027-01-01T00:00:00-10:00')), false);
});

test('founding-rate copy names the held price, the deadline and the 1 January price', async () => {
  const { foundingRateLine, foundingRateShortLine } = await import('../lib/price-hold.mjs');
  assert.equal(foundingRateLine(1999), '2027 founding rate: $1,999 per person until 31 December. From 1 January, the price is $2,199.');
  assert.equal(foundingRateShortLine(), 'Founding rate — rises to $2,199 on 1 January.');
});

test('the announced price rise does not touch checkout amounts', async () => {
  const pricing = await import('../lib/group-pricing.mjs');
  assert.equal(pricing.BASE_PRICE_USD, 1999);
  assert.equal(pricing.BASE_ONLINE_PAYMENT_USD, 999);
  assert.equal(pricing.BASE_LOCAL_FAMILY_PAYMENT_USD, 1000);
});

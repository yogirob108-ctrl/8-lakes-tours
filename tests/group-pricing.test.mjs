import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BASE_LOCAL_FAMILY_PAYMENT_USD, BASE_ONLINE_PAYMENT_USD, BASE_PRICE_USD, GROUP_PRICING_TIERS, getGroupPricing } from '../lib/group-pricing.mjs';

test('the split always reconstructs the advertised per-person price', () => {
  for (let guestCount = 1; guestCount <= 8; guestCount += 1) {
    const pricing = getGroupPricing(guestCount);
    assert.equal(
      pricing.onlinePerPersonUsd + pricing.localFamilyPerPersonUsd,
      pricing.perPersonUsd,
      `${guestCount} guests: split must equal the tier price`,
    );
    assert.equal(pricing.onlinePaymentUsd + pricing.localFamilyPaymentUsd, pricing.totalTripValueUsd);
  }
});

test('the group discount is shared evenly rather than taken from the host family', () => {
  for (let guestCount = 1; guestCount <= 8; guestCount += 1) {
    const pricing = getGroupPricing(guestCount);
    const onlineGivesUp = BASE_ONLINE_PAYMENT_USD - pricing.onlinePerPersonUsd;
    const familyGivesUp = BASE_LOCAL_FAMILY_PAYMENT_USD - pricing.localFamilyPerPersonUsd;
    assert.equal(onlineGivesUp, familyGivesUp, `${guestCount} guests: both sides absorb the same amount`);
    assert.equal(onlineGivesUp + familyGivesUp, pricing.perPersonSavingsUsd);
  }
});

test('every tier splits into whole dollars', () => {
  for (const tier of GROUP_PRICING_TIERS) {
    assert.equal((BASE_PRICE_USD - tier.perPersonUsd) % 2, 0, `${tier.label} discount must be even`);
  }
  for (let guestCount = 1; guestCount <= 8; guestCount += 1) {
    const pricing = getGroupPricing(guestCount);
    assert.equal(Number.isInteger(pricing.onlinePerPersonUsd), true);
    assert.equal(Number.isInteger(pricing.localFamilyPerPersonUsd), true);
  }
});

test('the host family never earns less than $900 per guest', () => {
  for (let guestCount = 1; guestCount <= 8; guestCount += 1) {
    assert.ok(getGroupPricing(guestCount).localFamilyPerPersonUsd >= 900);
  }
});

test('the Buy Button tier is untouched at $999 per guest', () => {
  // The embedded Stripe Buy Button is a fixed $999 seat, so the only tier that
  // can self-serve must keep that exact per-person amount.
  assert.equal(getGroupPricing(1).onlinePerPersonUsd, 999);
  assert.equal(getGroupPricing(2).onlinePerPersonUsd, 999);
});

test('client and booking API share one pricing module rather than recomputing it', async () => {
  const [client, api] = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8'),
  ]);

  for (const source of [client, api]) {
    assert.match(source, /from '@\/lib\/group-pricing\.mjs'/);
    assert.doesNotMatch(source, /function getGroupPricing/);
  }
});

test('guest-facing copy quotes the current split ranges', async () => {
  const [client, terms] = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/terms/page.tsx', import.meta.url), 'utf8'),
  ]);

  // The cards show the base split; the group-rate dropdown derives each tier's
  // split from getGroupPricing so it can't drift from the invoice numbers.
  assert.match(client, /\$\{BASE_ONLINE_PAYMENT_USD\.toLocaleString\('en-US'\)\} pp/);
  assert.match(client, /\$\{BASE_LOCAL_FAMILY_PAYMENT_USD\.toLocaleString\('en-US'\)\} pp/);
  assert.match(client, /getGroupPricing\(tier\.min\)/);
  assert.match(client, /pricing\.onlinePerPersonUsd/);
  assert.match(client, /pricing\.localFamilyPerPersonUsd/);
  // The old flat-$999 promise must not survive anywhere a guest reads a range.
  assert.doesNotMatch(client, /\$800–\$1,000/);
  assert.doesNotMatch(terms, /\$800–\$1,000/);
});

test('the 50% inside-21-days refund is stated everywhere the policy is published', async () => {
  const sources = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/faq/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/terms/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../public/llms.txt', import.meta.url), 'utf8'),
    readFile(new URL('../public/llms-full.txt', import.meta.url), 'utf8'),
  ]);

  for (const source of sources) {
    assert.match(source, /50% of the online booking payment/);
    // The refund is net of processing fees, matching the outside-21-days rule.
    assert.match(source, /50% of the online booking payment[^.]*?minus unrecoverable[^.]*?processing fees/);
  }
});

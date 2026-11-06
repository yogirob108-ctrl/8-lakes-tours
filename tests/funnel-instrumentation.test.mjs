import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8');
const landing = await readFile(new URL('../app/horse-trekking-mongolia/LandingCta.tsx', import.meta.url), 'utf8');

test('funnel event contract excludes raw booking identifiers and click-only payment conversion', () => {
  assert.match(source, /const FUNNEL_EVENT_PARAMS/);
  assert.doesNotMatch(source, /stripe_payment_click/);
  assert.doesNotMatch(source, /reference: payload\.reference/);
  assert.match(source, /begin_checkout/);
  assert.match(source, /checkout_redirect_started/);
  assert.match(source, /checkoutCreatedTrackedRef/);
  assert.match(source, /destination\.origin !== 'https:\/\/checkout\.stripe\.com'/);
});

test('tour visibility and booking CTAs are deduped and accurately named', () => {
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /tourViewTrackedRef/);
  assert.match(source, /view_tour/);
  assert.match(source, /booking_cta_click/);
  assert.match(landing, /booking_cta_click/);
  assert.doesNotMatch(landing, /paid_search_cta_click/);
});

test('consent-mode dispatch retains gtag and allows only contract fields', () => {
  assert.match(source, /Object\.entries\(properties\)\.filter/);
  assert.match(source, /window\.gtag\('event', name/);
  assert.match(source, /cookieless behavior/);
});

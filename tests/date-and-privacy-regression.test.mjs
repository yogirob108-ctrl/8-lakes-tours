import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AVAILABILITY_CHECK, UNKNOWN_SELECTION, manualPaymentReason } from '../lib/tour-booking.mjs';

test('blank and unknown dates fail closed rather than becoming availability requests', () => {
  assert.equal(manualPaymentReason('', 1), UNKNOWN_SELECTION);
  assert.equal(manualPaymentReason('not a published departure', 1), UNKNOWN_SELECTION);
  assert.equal(manualPaymentReason('2026 Private Group Date', 1), AVAILABILITY_CHECK);
});

test('date selector is required, validates before submit, and restoration cannot overwrite a new choice', async () => {
  const [source, api] = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /<select id="tour_date"[\s\S]*required/);
  assert.match(source, /Choose a tour date before continuing\./);
  assert.match(source, /if \(!currentTourDate\) setSelectedTourDate/);
  assert.match(api, /if \(!tourDate \|\| !isBookableTourDate\(tourDate\)\) return jsonError/);
  assert.ok(api.indexOf('!tourDate || !isBookableTourDate') < api.indexOf('!isSupabaseAdminConfigured'));
});

test('privacy controls move from fixed overlay to the ordinary footer after a saved choice', async () => {
  const [banner, home] = await Promise.all([
    readFile(new URL('../app/components/GoogleConsentBanner.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(banner, /position:\s*fixed[\s\S]*privacy-choice-trigger/);
  assert.match(home, /privacy-choices-link/);
  assert.match(banner, /eight-lakes:open-privacy-choices/);
});

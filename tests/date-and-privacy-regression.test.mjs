import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AVAILABILITY_CHECK, UNKNOWN_SELECTION, manualPaymentReason } from '../lib/tour-booking.mjs';

test('blank and unknown dates fail closed rather than becoming availability requests', () => {
  assert.equal(manualPaymentReason('', 1), UNKNOWN_SELECTION);
  assert.equal(manualPaymentReason('not a published departure', 1), UNKNOWN_SELECTION);
  // The historical private labels normalize onto the unified request option,
  // which stays an availability question at every group size.
  assert.equal(manualPaymentReason('2026 Private Group Date', 1), AVAILABILITY_CHECK);
});

test('date selector is required, validates before submit, and restoration cannot overwrite a new choice', async () => {
  const [source, api] = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8'),
  ]);
  // The date is chosen in the season pickers and carried into the form as a
  // hidden field, so the guarantee is that it still cannot be empty at submit.
  assert.match(source, /<input type="hidden" name="tour_date" value=\{selectedTourDate\} \/>/);
  assert.match(source, /input\[name="tour_date"\][\s\S]{0,400}Choose a tour date before continuing\./);
  assert.doesNotMatch(source, /<select id="tour_date"/, 'the duplicate date control must not come back');
  assert.match(source, /if \(!tourDateTouchedRef\.current && draftTourDate\) setSelectedTourDate\(draftTourDate\)/, 'a draft date lands only while the visitor has not touched a date control');
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

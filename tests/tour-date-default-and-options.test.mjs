import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TOUR_DATES, getVisibleTourDates, getDefaultTourDate, REQUEST_ONLY_OPTION_DATE } from '../lib/tour-dates.mjs';
import { manualPaymentReason, isBookableTourDate, isRequestOnlyTourDate, normalizeTourDateSelection, AVAILABILITY_CHECK, UNKNOWN_SELECTION } from '../lib/tour-booking.mjs';

test('fresh form defaults to the earliest truly available scheduled departure', () => {
  const now = new Date('2026-09-15T10:00:00Z');
  assert.equal(getDefaultTourDate(TOUR_DATES, now), 'September 23 – October 1, 2026');
});

test('the default ignores request-only options and elapsed departures', () => {
  // The 2026 season now ends in October, so mid-November rolls to 2027.
  const now = new Date('2026-11-13T10:00:00Z');
  assert.equal(getDefaultTourDate(TOUR_DATES, now), 'May 4 – 12, 2027');
  assert.equal(getDefaultTourDate([
    { date: 'Elapsed', startDate: '2026-01-01' },
    { date: REQUEST_ONLY_OPTION_DATE, requiresConfirmation: true, availableUntil: '2099-01-01' },
  ], now), '');
});

test('mid-2027 keeps selling the rest of the 2027 season', () => {
  // Every 2026 departure has expired; the remaining 2027 dates stay bookable.
  const now = new Date('2027-06-02T10:00:00Z');
  const visible = getVisibleTourDates(TOUR_DATES, now);
  assert.equal(getDefaultTourDate(TOUR_DATES, now), 'June 15 – 23, 2027');
  assert.equal(visible.every(option => !option.startDate || option.startDate.startsWith('2027')), true);
  assert.equal(visible.some(option => option.date === REQUEST_ONLY_OPTION_DATE), true);
});

test('past the last departure there is no invented default and the request option is gone', () => {
  const now = new Date('2027-11-01T10:00:00Z');
  assert.equal(getDefaultTourDate(TOUR_DATES, now), '');
  assert.deepEqual(getVisibleTourDates(TOUR_DATES, now).map(option => option.date), []);
});

test('request options consolidate into one private group date on request', () => {
  const requestOptions = TOUR_DATES.filter(option => option.requiresConfirmation === true);
  assert.equal(requestOptions.length, 1);
  assert.equal(requestOptions[0].date, REQUEST_ONLY_OPTION_DATE);
  assert.equal(REQUEST_ONLY_OPTION_DATE, 'Private group date on request');
  for (const legacy of ['2026 Private Group Date', '2027 Private Group Date', '2027 Small-Group Departures']) {
    assert.equal(TOUR_DATES.some(option => option.date === legacy), false, `${legacy} must no longer be a selectable option`);
  }
  assert.equal(requestOptions[0].availableUntil, '2027-10-19');
  assert.equal(requestOptions[0].startDate, undefined, 'request option is never a departure');
});

test('legacy private and interest labels normalize to the unified option', () => {
  for (const legacy of ['2026 Private Group Date', '2027 Private Group Date', '2027 Small-Group Departures']) {
    assert.equal(normalizeTourDateSelection(legacy), REQUEST_ONLY_OPTION_DATE);
    assert.equal(isRequestOnlyTourDate(legacy), true);
    assert.equal(manualPaymentReason(legacy, 4), AVAILABILITY_CHECK, `${legacy} keeps request-only handling`);
    assert.equal(isBookableTourDate(legacy, new Date('2026-09-15T10:00:00Z')), true, `${legacy} stays bookable via normalization`);
  }
  assert.equal(normalizeTourDateSelection('  2027 Small-Group Departures  '), REQUEST_ONLY_OPTION_DATE);
  assert.equal(normalizeTourDateSelection(''), '');
  assert.equal(normalizeTourDateSelection('September 23 – October 1, 2026'), 'September 23 – October 1, 2026');
  assert.equal(normalizeTourDateSelection('invented-date'), 'invented-date');
});

test('normalized legacy labels keep failing closed for unknown or blank values', () => {
  assert.equal(manualPaymentReason('', 1), UNKNOWN_SELECTION);
  assert.equal(manualPaymentReason('invented-date', 1), UNKNOWN_SELECTION);
  assert.equal(isBookableTourDate('', new Date()), false);
});

test('booking API normalizes legacy selections before validation and storage', async () => {
  const api = await readFile(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8');
  assert.match(api, /normalizeTourDateSelection\(bookingInput\.tour_date\)/);
  assert.ok(api.indexOf('normalizeTourDateSelection(bookingInput.tour_date)') < api.indexOf('isBookableTourDate(tourDate)'), 'normalization must run before bookability validation');
});

test('fresh form preselects the default with no visible placeholder and correct CTA', async () => {
  const client = await readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8');
  assert.match(client, /useState\(\(\) => getDefaultTourDate\(tourDates\)\)/, 'initial state is the earliest available departure');
  assert.doesNotMatch(client, /<option value="">\{?["'`]Select date["'`]?\}?<\/option>/, 'placeholder must not be unconditional');
  assert.match(client, /\{!selectedTourDate && <option value="">Select date<\/option>\}/, 'placeholder only renders when no date is selected (no bookable departure or blank draft)');
  assert.match(client, /import \{[^}]*getDefaultTourDate[^}]*\} from '@\/lib\/tour-dates\.mjs'/);
  assert.match(client, /tourDateTouchedRef\.current = true/, 'both controls mark the canonical selection as user-touched');
  assert.match(client, /manualPaymentReason\(selectedTourDate, guestCount\)/, 'CTA keeps deriving from the canonical selection');
});

test('restore honours a saved draft date or private choice but never overrides a user edit', async () => {
  const client = await readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8');
  assert.match(client, /normalizeTourDateSelection\(String\(draft\.tour_date \|\| ''\)\)/, 'restored draft labels normalize into the unified option');
  assert.match(client, /if \(!tourDateTouchedRef\.current && draftTourDate\) setSelectedTourDate\(draftTourDate\)/, 'untouched default yields to a real saved choice; a user edit is never overwritten');
});

test('public AI references describe the unified request option', async () => {
  const [summary, full] = await Promise.all([
    readFile(new URL('../public/llms.txt', import.meta.url), 'utf8'),
    readFile(new URL('../public/llms-full.txt', import.meta.url), 'utf8'),
  ]);
  for (const source of [summary, full]) {
    assert.match(source, /Private group date on request/);
    assert.match(source, /2027/);
    assert.match(source, /confirm.*before payment|before payment.*confirm/i);
  }
});

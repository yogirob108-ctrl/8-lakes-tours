import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { AVAILABILITY_CHECK, UNKNOWN_SELECTION, canAutomaticallyConfirmBooking, isBookableTourDate, isRequestOnlyTourDate, manualPaymentReason, requiresManualPaymentLink } from '../lib/tour-booking.mjs';
import { TOUR_DATES, getVisibleTourDates } from '../lib/tour-dates.mjs';

test('2027 public inventory is request-only and contains no invented fixed dates', () => {
  const interest = TOUR_DATES.find(option => option.date === '2027 Small-Group Departures');
  const privateDate = TOUR_DATES.find(option => option.date === '2027 Private Group Date');

  assert.ok(interest);
  assert.ok(privateDate);
  assert.equal(interest.requiresConfirmation, true);
  assert.equal(privateDate.requiresConfirmation, true);
  assert.equal('startDate' in interest, false);
  assert.equal('startDate' in privateDate, false);
});

test('expired request-only inventory is hidden using the Mongolia date boundary', () => {
  const options = [
    { date: '2026 Private Group Date', availableUntil: '2026-09-30', requiresConfirmation: true },
    { date: '2027 Private Group Date', availableUntil: '2027-09-30', requiresConfirmation: true },
  ];

  assert.deepEqual(
    getVisibleTourDates(options, new Date('2026-09-30T16:00:00Z')).map(option => option.date),
    ['2027 Private Group Date'],
  );
});

test('request-only date requires manual confirmation for one or two guests', () => {
  assert.equal(isRequestOnlyTourDate('2027 Small-Group Departures'), true);
  assert.equal(requiresManualPaymentLink('2027 Small-Group Departures', 1), true);
  assert.equal(requiresManualPaymentLink('2027 Private Group Date', 2), true);
});

test('scheduled groups now use exact automatic checkout', () => {
  assert.equal(requiresManualPaymentLink('September 14 – 22, 2026', 3), false);
});

test('groups on fixed dates no longer need an invoice', () => {
  assert.equal(manualPaymentReason('September 14 – 22, 2026', 2), null);
  assert.equal(manualPaymentReason('September 14 – 22, 2026', 3), null);
  assert.equal(manualPaymentReason('September 23 – October 1, 2026', 8), null);
});

test('request-only options stay an availability question at every group size', () => {
  assert.equal(manualPaymentReason('2027 Private Group Date', 1), AVAILABILITY_CHECK);
  assert.equal(manualPaymentReason('2027 Private Group Date', 5), AVAILABILITY_CHECK);
  assert.equal(manualPaymentReason('2027 Small-Group Departures', 4), AVAILABILITY_CHECK);
});

test('an unselected or invented date is neither an invoice nor an availability check', () => {
  assert.equal(manualPaymentReason('', 1), UNKNOWN_SELECTION);
  assert.equal(manualPaymentReason('invented-date', 6), UNKNOWN_SELECTION);
});

test('a fixed departure for one or two guests can retain the standard payment path', () => {
  assert.equal(requiresManualPaymentLink('August 24 – September 1, 2026', 1), false);
});

test('September through November stays full with two directly bookable departures per month', () => {
  const expectedLateSeasonDates = [
    'September 14 – 22, 2026',
    'September 23 – October 1, 2026',
    'October 7 – 15, 2026',
    'October 21 – 29, 2026',
    'November 4 – 12, 2026',
    'November 18 – 26, 2026',
  ];

  const actualLateSeasonDates = TOUR_DATES
    .filter(option => option.startDate >= '2026-09-01' && option.startDate <= '2026-11-30')
    .map(option => option.date);

  assert.deepEqual(actualLateSeasonDates, expectedLateSeasonDates);
  for (const date of expectedLateSeasonDates) {
    assert.equal(isRequestOnlyTourDate(date), false);
    assert.equal(requiresManualPaymentLink(date, 1), false);
    assert.equal(requiresManualPaymentLink(date, 2), false);
  }
});

test('the 2026 private-date option remains available through November', () => {
  const privateDate = TOUR_DATES.find(option => option.date === '2026 Private Group Date');

  assert.ok(privateDate);
  assert.equal(privateDate.availableUntil, '2026-11-30');
  assert.match(privateDate.detail, /November 2026/);
  assert.equal(privateDate.requiresConfirmation, true);
});

test('every fixed 2026 departure is free of the request-only gate', () => {
  const fixedDepartures = TOUR_DATES.filter(option => option.startDate);
  assert.ok(fixedDepartures.length > 0);
  for (const option of fixedDepartures) {
    assert.notEqual(option.requiresConfirmation, true, `${option.date} should be directly bookable`);
  }
});

test('unknown date labels fail closed and cannot use automatic payment', () => {
  assert.equal(isBookableTourDate('invented-date', new Date('2026-08-12T12:00:00Z')), false);
  assert.equal(requiresManualPaymentLink('invented-date', 1), true);
});

test('server bookability excludes expired departures and allows visible inventory', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  assert.equal(isBookableTourDate('August 4 – 12, 2026', now), false);
  assert.equal(isBookableTourDate('September 14 – 22, 2026', now), true);
  assert.equal(isBookableTourDate('September 23 – October 1, 2026', now), true);
  assert.equal(isBookableTourDate('2027 Small-Group Departures', now), true);
});

test('automatic Stripe confirmation covers visible scheduled groups but never private or expired dates', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  assert.equal(canAutomaticallyConfirmBooking('August 24 – September 1, 2026', 1, now), true);
  assert.equal(canAutomaticallyConfirmBooking('August 24 – September 1, 2026', 2, now), true);
  assert.equal(canAutomaticallyConfirmBooking('August 24 – September 1, 2026', 3, now), true);
  assert.equal(canAutomaticallyConfirmBooking('September 14 – 22, 2026', 1, now), true);
  assert.equal(canAutomaticallyConfirmBooking('September 23 – October 1, 2026', 2, now), true);
  assert.equal(canAutomaticallyConfirmBooking('September 23 – October 1, 2026', 4, now), true);
  assert.equal(canAutomaticallyConfirmBooking('2027 Small-Group Departures', 1, now), false);
  assert.equal(canAutomaticallyConfirmBooking('2027 Private Group Date', 2, now), false);
  assert.equal(canAutomaticallyConfirmBooking('August 4 – 12, 2026', 1, now), false);
  assert.equal(canAutomaticallyConfirmBooking('', 1, now), false);
  assert.equal(canAutomaticallyConfirmBooking('invented-date', 1, now), false);
});

test('manual-confirmation emails use neutral availability-request wording', async () => {
  const email = await readFile(new URL('../lib/email.ts', import.meta.url), 'utf8');
  assert.match(email, /availability request/);
  assert.doesNotMatch(email, /\$\{guestCount\}-guest group request|group request from/);
});

test('client and booking API both use the shared payment-gating contract', async () => {
  const [client, api, webhook] = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/stripe/webhook/route.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(client, /manualPaymentReason\(selectedTourDate, guestCount\)/);
  assert.match(api, /isBookableTourDate\(tourDate\)/);
  assert.match(api, /requiresManualPaymentLink\(tourDate, groupPricing\.guestCount\)/);
  assert.match(api, /manualPaymentReason\(tourDate, groupPricing\.guestCount\)/);
  assert.match(webhook, /canAutomaticallyConfirmBooking\(booking\.tour_date, booking\.guest_count\)/);
  assert.ok(
    webhook.includes('inventoryAllowed ? await transitionBookingAfterPaymentClaim'),
    'manual-review gate must execute before automatic confirmation',
  );
});

test('public AI references defer to live inventory and describe 2027 as request-only', async () => {
  const [summary, full] = await Promise.all([
    readFile(new URL('../public/llms.txt', import.meta.url), 'utf8'),
    readFile(new URL('../public/llms-full.txt', import.meta.url), 'utf8'),
  ]);
  for (const source of [summary, full]) {
    assert.doesNotMatch(source, /seven fixed 2026 departures/i);
    assert.match(source, /live homepage is the source of truth/i);
    assert.match(source, /2027/i);
    assert.match(source, /confirm.*before payment|before payment.*confirm/i);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getVisibleTourDates } from '../lib/tour-dates.mjs';

const dates = [
  { date: 'June 22 – 30, 2026', startDate: '2026-06-22' },
  { date: 'July 28 – August 5, 2026', startDate: '2026-07-28' },
  { date: 'August 4 – 12, 2026', startDate: '2026-08-04' },
  { date: 'August 24 – September 1, 2026', startDate: '2026-08-24' },
  { date: 'Private Group Date', muted: true },
];

test('hides departures whose start date has arrived in Mongolia', () => {
  const visible = getVisibleTourDates(dates, new Date('2026-07-31T23:30:00Z'));

  assert.deepEqual(visible.map(option => option.date), [
    'August 4 – 12, 2026',
    'August 24 – September 1, 2026',
    'Private Group Date',
  ]);
});

test('keeps a future departure visible until its Mongolia start day', () => {
  const beforeStart = getVisibleTourDates(dates, new Date('2026-08-03T15:59:59Z'));
  const onStart = getVisibleTourDates(dates, new Date('2026-08-03T16:00:00Z'));

  assert.equal(beforeStart.some(option => option.date === 'August 4 – 12, 2026'), true);
  assert.equal(onStart.some(option => option.date === 'August 4 – 12, 2026'), false);
});

test('keeps the private-date request after the fixed season ends', () => {
  const visible = getVisibleTourDates(dates, new Date('2026-10-01T00:00:00Z'));

  assert.deepEqual(visible.map(option => option.date), ['Private Group Date']);
});

test('FAQ does not advertise a fixed count that becomes stale', async () => {
  const source = await readFile(new URL('../app/faq/page.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /shows seven fixed 2026 departures/i);
});

test('closed departures never show, even before they start', () => {
  const dates = [
    { date: 'October 7 – 15, 2026', startDate: '2026-10-07', closed: true },
    { date: 'May 4 – 12, 2027', startDate: '2027-05-04' },
  ];
  const visible = getVisibleTourDates(dates, new Date('2026-09-30T00:00:00Z'));
  assert.deepEqual(visible.map(option => option.date), ['May 4 – 12, 2027']);
});

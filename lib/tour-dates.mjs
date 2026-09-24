const MONGOLIA_TIME_ZONE = 'Asia/Ulaanbaatar';

// One explicit request-only choice replaces the year-specific private/interest
// options. Stored bookings and drafts keep their historical labels; the
// normalizer maps them onto this option everywhere a selection is interpreted.
export const REQUEST_ONLY_OPTION_DATE = 'Private group date on request';

// Stored labels that meant a private/custom date or 2027 interest. They remain
// valid inputs forever so old drafts, bookings, and links keep working.
const LEGACY_REQUEST_ONLY_LABELS = new Set([
  '2026 Private Group Date',
  '2027 Private Group Date',
  '2027 Small-Group Departures',
]);
export { LEGACY_REQUEST_ONLY_LABELS };

export const TOUR_DATES = [
  { date: 'June 22 – 30, 2026', startDate: '2026-06-22', endDate: '2026-06-30', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'July 6 – 14, 2026', startDate: '2026-07-06', endDate: '2026-07-14', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'July 16 – 24, 2026', startDate: '2026-07-16', endDate: '2026-07-24', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'July 28 – August 5, 2026', startDate: '2026-07-28', endDate: '2026-08-05', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'August 4 – 12, 2026', startDate: '2026-08-04', endDate: '2026-08-12', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'August 24 – September 1, 2026', startDate: '2026-08-24', endDate: '2026-09-01', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'September 14 – 22, 2026', startDate: '2026-09-14', endDate: '2026-09-22', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'September 23 – October 1, 2026', startDate: '2026-09-23', endDate: '2026-10-01', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'October 7 – 15, 2026', startDate: '2026-10-07', endDate: '2026-10-15', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'October 21 – 29, 2026', startDate: '2026-10-21', endDate: '2026-10-29', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  // 2027 runs the same fortnightly cadence from May to October and books and
  // pays exactly like a 2026 departure — no availability request in between.
  { date: 'May 4 – 12, 2027', startDate: '2027-05-04', endDate: '2027-05-12', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'May 18 – 26, 2027', startDate: '2027-05-18', endDate: '2027-05-26', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'June 1 – 9, 2027', startDate: '2027-06-01', endDate: '2027-06-09', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'June 15 – 23, 2027', startDate: '2027-06-15', endDate: '2027-06-23', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'June 29 – July 7, 2027', startDate: '2027-06-29', endDate: '2027-07-07', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'July 13 – 21, 2027', startDate: '2027-07-13', endDate: '2027-07-21', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'July 27 – August 4, 2027', startDate: '2027-07-27', endDate: '2027-08-04', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'August 10 – 18, 2027', startDate: '2027-08-10', endDate: '2027-08-18', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'August 24 – September 1, 2027', startDate: '2027-08-24', endDate: '2027-09-01', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'September 7 – 15, 2027', startDate: '2027-09-07', endDate: '2027-09-15', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'September 21 – 29, 2027', startDate: '2027-09-21', endDate: '2027-09-29', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'October 5 – 13, 2027', startDate: '2027-10-05', endDate: '2027-10-13', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: 'October 19 – 27, 2027', startDate: '2027-10-19', endDate: '2027-10-27', detail: '9 Days · 8 Nights · Orkhon Valley, Mongolia', status: 'Open · max 8' },
  { date: REQUEST_ONLY_OPTION_DATE, detail: 'Choose your own dates · confirmed before payment', status: 'On Request', muted: true, availableUntil: '2027-10-19', requiresConfirmation: true },
];

// The founding rate is held for anyone booking a 2027 departure while the 2026
// season is still running; it is the same copy in the picker and the booking
// intro, so it lives here rather than being retyped in each.
export const FOUNDING_RATE_NOTE = 'Book a 2027 departure before the 2026 season ends and you pay 2026 prices.';
export const FOUNDING_RATE_HEADING = 'Claim the founding rate';
export const FOUNDING_RATE_CLOSER = 'Choose your date and lock it in today.';

export function getSeasonYear(option) {
  return option?.startDate ? option.startDate.slice(0, 4) : '';
}

function dateKeyInTimeZone(now, timeZone = MONGOLIA_TIME_ZONE) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('A valid Date is required');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getVisibleTourDates(tourDates, now = new Date()) {
  const today = dateKeyInTimeZone(now);
  return tourDates.filter(option => {
    if (option.startDate && option.startDate <= today) return false;
    if (option.availableUntil && option.availableUntil < today) return false;
    return true;
  });
}

// Earliest genuinely bookable scheduled departure in Mongolia time. Request-only
// options never seed the default, and when nothing is bookable the answer is an
// empty string — the explicit request option remains the visible fallback.
export function getDefaultTourDate(tourDates, now = new Date()) {
  const today = dateKeyInTimeZone(now);
  return tourDates
    .filter(option => option.startDate && !option.requiresConfirmation && option.startDate > today)
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))[0]?.date ?? '';
}

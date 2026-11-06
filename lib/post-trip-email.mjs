import { TOUR_DATES } from './tour-dates.mjs';

export const POST_TRIP_TEMPLATE = 'post_trip_referral';
// Send once the guest is home and the trip is still fresh, never months later.
export const POST_TRIP_MIN_DAYS_AFTER_END = 3;
export const POST_TRIP_MAX_DAYS_AFTER_END = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = new Map([
  ['jan', 0], ['january', 0], ['feb', 1], ['february', 1], ['mar', 2], ['march', 2],
  ['apr', 3], ['april', 3], ['may', 4], ['jun', 5], ['june', 5], ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7], ['sep', 8], ['sept', 8], ['september', 8], ['oct', 9], ['october', 9],
  ['nov', 10], ['november', 10], ['dec', 11], ['december', 11],
]);

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function dateAtUtc(year, monthName, day) {
  const month = MONTHS.get(String(monthName).toLowerCase());
  const numericDay = Number(day);
  if (month === undefined || !Number.isInteger(numericDay) || numericDay < 1 || numericDay > 31) return null;
  const date = new Date(Date.UTC(Number(year), month, numericDay));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === month && date.getUTCDate() === numericDay ? date : null;
}

// Historical labels can be trusted only when they include one explicit year.
// A missing year is intentionally unknown; never infer it from the current season.
export function parseExplicitTourEndDate(tourDate) {
  const label = String(tourDate ?? '').trim().replace(/[–—]/g, '-');
  let match = label.match(/^([A-Za-z]+)\s*(\d{1,2})(?:st|nd|rd|th)?\s*-\s*(?:([A-Za-z]+)\s*)?(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})$/i);
  if (match) return dateAtUtc(match[5], match[3] || match[1], match[4]);
  match = label.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s*-\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s*,?\s*(\d{4})$/i);
  return match ? dateAtUtc(match[5], match[4], match[3]) : null;
}

function resolveTourEndDate(tourDate, tourDates, departureEndDate) {
  // The persisted departure is authoritative when present. Historical rows can
  // safely fall back to a label only when its year is explicit.
  const linkedDepartureEnd = validIsoDate(departureEndDate);
  if (linkedDepartureEnd) return linkedDepartureEnd;
  const parsed = parseExplicitTourEndDate(tourDate);
  if (parsed) return parsed;
  const option = tourDates.find(item => item.date === String(tourDate ?? '').trim());
  return validIsoDate(option?.endDate);
}

/** @param {*} tourDate @param {Date} [now] @param {*} [tourDates] @param {string|null|undefined} [departureEndDate] */
export function daysSinceTourEnd(tourDate, now = new Date(), tourDates = TOUR_DATES, departureEndDate = null) {
  const end = resolveTourEndDate(tourDate, tourDates, departureEndDate);
  if (!end) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - end.valueOf()) / DAY_MS);
}

export function selectPostTripCandidate({ enabled, verifiedStripe, daysSinceEnd, sentTemplates }) {
  if (!enabled || !verifiedStripe || !Number.isInteger(daysSinceEnd)) return null;
  if (daysSinceEnd < POST_TRIP_MIN_DAYS_AFTER_END || daysSinceEnd > POST_TRIP_MAX_DAYS_AFTER_END) return null;
  return sentTemplates.has(POST_TRIP_TEMPLATE) ? null : POST_TRIP_TEMPLATE;
}

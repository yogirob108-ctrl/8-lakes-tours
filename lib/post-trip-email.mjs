import { TOUR_DATES } from './tour-dates.mjs';

export const POST_TRIP_TEMPLATE = 'post_trip_referral';
// Send once the guest is home and the trip is still fresh, never months later.
export const POST_TRIP_MIN_DAYS_AFTER_END = 3;
export const POST_TRIP_MAX_DAYS_AFTER_END = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// The end date comes from the published departure list, never from parsing a
// free-text label: an unknown or request-only date has no end and never sends.
export function daysSinceTourEnd(tourDate, now = new Date(), tourDates = TOUR_DATES) {
  const label = String(tourDate ?? '').trim();
  const option = tourDates.find(item => item.date === label);
  if (!option?.endDate) return null;
  const end = Date.parse(`${option.endDate}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - end) / DAY_MS);
}

export function selectPostTripCandidate({ enabled, verifiedStripe, daysSinceEnd, sentTemplates }) {
  if (!enabled || !verifiedStripe || !Number.isInteger(daysSinceEnd)) return null;
  if (daysSinceEnd < POST_TRIP_MIN_DAYS_AFTER_END || daysSinceEnd > POST_TRIP_MAX_DAYS_AFTER_END) return null;
  return sentTemplates.has(POST_TRIP_TEMPLATE) ? null : POST_TRIP_TEMPLATE;
}

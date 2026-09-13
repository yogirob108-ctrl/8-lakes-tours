import { TOUR_DATES, getVisibleTourDates } from './tour-dates.mjs';

export function isRequestOnlyTourDate(value, tourDates = TOUR_DATES) {
  const selected = String(value ?? '').trim();
  if (!selected) return false;
  return tourDates.some(option => option.date === selected && option.requiresConfirmation === true);
}

export function isBookableTourDate(value, now = new Date(), tourDates = TOUR_DATES) {
  const selected = String(value ?? '').trim();
  if (!selected) return false;
  return getVisibleTourDates(tourDates, now).some(option => option.date === selected);
}

export function canAutomaticallyConfirmBooking(tourDate, guestCount, now = new Date(), tourDates = TOUR_DATES) {
  return isBookableTourDate(tourDate, now, tourDates)
    && !requiresManualPaymentLink(tourDate, guestCount, tourDates);
}

export const GROUP_INVOICE = 'group_invoice';
export const AVAILABILITY_CHECK = 'availability';
export const UNKNOWN_SELECTION = 'unknown_selection';

// Scheduled groups of 1–8 use exact server-side Checkout Sessions.
// The legacy GROUP_INVOICE constant remains for historical email templates.
/** @returns {string | null} */
export function manualPaymentReason(tourDate, guestCount, tourDates = TOUR_DATES) {
  const selected = String(tourDate ?? '').trim();
  if (!tourDates.some(option => option.date === selected)) return UNKNOWN_SELECTION;
  if (isRequestOnlyTourDate(selected, tourDates)) return AVAILABILITY_CHECK;
  if (!Number.isInteger(Number(guestCount)) || Number(guestCount) < 1 || Number(guestCount) > 8) return UNKNOWN_SELECTION;
  return null;
}

export function requiresManualPaymentLink(tourDate, guestCount, tourDates = TOUR_DATES) {
  return manualPaymentReason(tourDate, guestCount, tourDates) !== null;
}

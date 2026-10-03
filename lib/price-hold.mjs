// Current prices are held for 2027 bookings made by New Year. The cut-off is
// the end of 31 December in Hawaii, one of the last places on Earth to reach
// the new year, so no visitor anywhere loses a day of the offer.
export const PRICE_HOLD_ENDS_AT = '2027-01-01T10:00:00Z';
export const PRICE_HOLD_DEADLINE_LABEL = '31 December';

export function isPriceHoldActive(now = new Date()) {
  return now.getTime() < Date.parse(PRICE_HOLD_ENDS_AT);
}

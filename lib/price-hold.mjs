// Current prices are held for 2027 bookings made by New Year. The cut-off is
// the end of 31 December in Hawaii, one of the last places on Earth to reach
// the new year, so no visitor anywhere loses a day of the offer.
export const PRICE_HOLD_ENDS_AT = '2027-01-01T10:00:00Z';
export const PRICE_HOLD_DEADLINE_LABEL = '31 December';

// The 1 January 2027 base price. Display copy only: checkout amounts and the
// group tiers live in group-pricing.mjs and are not changed by this.
export const PRICE_AFTER_HOLD_USD = 2199;
export const PRICE_INCREASE_DATE_LABEL = '1 January';

const usd = amount => `$${amount.toLocaleString('en-US')}`;

export function foundingRateLine(foundingPriceUsd) {
  return `2027 founding rate: ${usd(foundingPriceUsd)} per person until ${PRICE_HOLD_DEADLINE_LABEL}. From ${PRICE_INCREASE_DATE_LABEL}, the price is ${usd(PRICE_AFTER_HOLD_USD)}.`;
}

export function foundingRateShortLine() {
  return `Founding rate — rises to ${usd(PRICE_AFTER_HOLD_USD)} on ${PRICE_INCREASE_DATE_LABEL}.`;
}

export function isPriceHoldActive(now = new Date()) {
  return now.getTime() < Date.parse(PRICE_HOLD_ENDS_AT);
}

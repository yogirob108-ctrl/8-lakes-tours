# Review request: 2027 founding-rate copy (f8e8261, 01c0b82, a5661c3)

Automated 24h review flagged these pricing-related commits for a second pair of eyes before relying on them for live bookings.

- `lib/price-hold.mjs`: adds `PRICE_AFTER_HOLD_USD = 2199`, `PRICE_INCREASE_DATE_LABEL`, `foundingRateLine`, `foundingRateShortLine`. Display copy only.
- `app/HomePageClient.tsx`, `app/faq/page.tsx`, `public/llms*.txt`: show "$1,999 until 31 December, $2,199 from 1 January".
- `lib/group-pricing.mjs`, `app/api/**`, Stripe code: **unchanged**. Checkout amounts still use `BASE_PRICE_USD = 1999` (asserted in `tests/price-hold.test.mjs`).

Things to confirm:
1. `PRICE_AFTER_HOLD_USD` is not wired into checkout, so on 1 January the charged price will NOT rise to $2,199 unless group-pricing is changed then. The copy and the charge must be switched together.
2. Hold ends `2027-01-01T10:00:00Z` (midnight HST 1 Jan is 10:00Z), but copy says "31 December" with no timezone.
3. Unrelated: `tests/*` that import `typescript` fail where devDeps aren't installed (same before these commits).

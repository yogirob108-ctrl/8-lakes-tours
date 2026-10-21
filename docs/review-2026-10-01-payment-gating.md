# Review flag: payment, pricing and date-gating changes (last 24h, to 2026-10-01)

Review-only draft PR so a human looks at these before relying on them for live bookings. No code change here.

## Payment / pricing
- `9859376` (Robert Zaher) adds `lib/price-hold.mjs`: current prices held for 2027 bookings until 2027-01-01T10:00Z. Terms text drops "2026" from the price clause; amounts ($999/$974/$949/$899 online) unchanged.
- `685850c` (Henry Willmott) paginates `approved_payment_bindings` (Stripe) reads in `app/api/cron/drip-emails/reconcile/route.ts`.
- `8fdc96f`, `90d1169`, `e21e9dd` (Henry Willmott): post-trip email sender, new SQL migrations, new env flags `POST_TRIP_EMAIL_ENABLED`, `PUBLIC_LIFECYCLE_SEND_ENABLED` (check they are set deliberately in Vercel; see docs/env-vars.md).

## Trip date / booking gating
- `lib/tour-dates.mjs`: new `closed` flag; Oct 2026 and Oct 2027 departures closed; request-only option `availableUntil` moved 2027-10-19 -> 2027-09-21. `getVisibleTourDates` / `getDefaultTourDate` skip closed dates.

## Result
`npm test` 366/366 pass and `tsc --noEmit` clean on origin/main (4c760e5). No Stripe amount or checkout-creation code changed.

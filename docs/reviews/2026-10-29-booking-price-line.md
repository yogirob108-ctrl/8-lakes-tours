# Review: booking section price line removed (2026-10-29)

Commit `299ded8` (Robert Zaher, 2026-10-28), already on `main`.

- Removes the line "The trip is $1,999 per person, and group rates apply for 3–8 guests." from the "Reserve your spot" section of `app/HomePageClient.tsx`; the test is updated to assert it is gone.
- Display copy only. No Stripe code, amounts, env vars, or booking/date gating touched.
- `tests/landing-copy-cleanup.test.mjs` passes (3/3).
- Check: the price card and "See group rates (3–8 guests)" summary still show the price in the booking section.

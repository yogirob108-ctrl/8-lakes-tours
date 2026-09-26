# Scheduled 24h commit review — 2026-09-18

No code changes proposed here. This is a flag-only PR from the scheduled repo-review
routine: policy is that any Stripe/pricing/deposit-flow-adjacent change gets a second
pair of eyes, even when it looks technically correct.

## In scope

- `354fa1c` — **Add traveller gender migration: nullable allowlisted column with
  absent-key preservation** (#59)
- `28f60c0` — **Abandoned-checkout stage cadence: durable DEFAULT-OFF rollout gate,
  two-stage journal, legacy ledger seeding** (#60)

Both were opened **and merged by GitHub user `kokosthief` (Henry Willmott)** within
1–2 minutes of opening each PR — no independent reviewer, and neither is
`yogirob108-ctrl`, the account this routine runs as.

## Why these two are flagged

**#59** re-issues `create_public_booking` and `update_ops_booking_record` in full via
migration, including the parameters that carry deposit/pricing data
(`total_trip_value_usd`, `online_due_usd`, `family_cash_due_usd`). The commit message
claims the bodies are "byte-identical to canonical ... with surgical gender
additions," which the migration is not able to enforce mechanically — a live
re-issue of the two functions that own booking creation and Ops edits is exactly
the kind of change this policy exists to catch, regardless of how careful the diff
looks.

**#60** adds Stripe Checkout Session verification logic to the abandoned-checkout
recovery path (session status/payment_status/amount_total/metadata matching in
`lib/abandoned-checkout.mjs`) and a new SQL rollout gate + stage journal. The new
cadence is gated **off by default** in the database
(`abandoned_cadence_rollout.mode = 'off'` seeded by the migration) and nothing is
enrolled or sent by applying it, per the commit message — but it still touches
Stripe session data and the payments ledger, so it's in scope.

## Verification performed by the review routine

- `npm ci` (fresh install), `npx tsc --noEmit` — clean
- `npm run build` — clean production build; `/api/stripe/webhook`, `/api/checkout`,
  `/api/cron/abandoned-checkouts` all compile and list as dynamic routes
- `npm test` — **329/329 passing**, matching the #60 commit message's own count
- No env vars added or changed by either commit; #60's rollout gate is a DB row,
  not an env var, so there's no production env-var action needed to keep it inert
- `lib/tour-dates.mjs` and `lib/tour-booking.mjs` (trip-date/booking-gating logic)
  were **not** touched by either commit in this window

## Standing pattern — still unaddressed

This is the third flag from this routine in four days, and the first two are still
open with no human comment beyond the routine's own updates:

- **#54** (opened 2026-09-15) — unreviewed Stripe/payment-lifecycle pushes
- **#58** (opened 2026-09-16) — Stripe webhook GA4 payment-conversion retry fix, plus
  two direct-to-`main` pushes with zero PR trail from `agent@8lakestours.com`

`kokosthief` continues to open and self-merge PRs touching payment-adjacent code
within about a minute of opening them, with no second reviewer, on all three
occasions. Recommend deciding whether that account should have merge rights on
`main` at all, or at minimum requiring a review before merge for anything under
`supabase/migrations/`, `lib/abandoned-checkout.mjs`, `lib/tour-booking.mjs`, or
`app/api/stripe/`.

## Ask

Please review #59 and #60 against the live database and Stripe dashboard, and take
a look at #54 and #58 if they haven't been addressed yet. Nothing to merge here —
safe to close this PR once reviewed.

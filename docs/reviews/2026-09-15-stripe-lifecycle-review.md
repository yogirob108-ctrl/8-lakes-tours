# Review request: Stripe / payment-lifecycle changes (2026-09-14 16:06 UTC – 2026-09-15 16:06 UTC)

Opened automatically by the scheduled repo-review routine. No code changes are
proposed here — this PR exists only to get a second pair of eyes on payment
logic before/while it's live, per standing instructions for this routine.

## Why this PR exists

Nearly all commits pushed to `main` in the last 24 hours touch Stripe
reconciliation, invoice/payment-intent evidence, or lifecycle email dispatch
tied to payment status. All of them were authored and **pushed directly to
`main` by GitHub user `kokosthief`** (a write-access collaborator, not the
account this routine runs as) with **no pull request** — unlike three earlier
same-day changes (#51, #52, #53) which did go through PR review.

Automated checks are clean:
- `npx tsc --noEmit` — no errors
- `npx next build` — succeeds
- `npm test` — 257/257 passing

That confirms the code is internally consistent, not that the payment logic
is correct in production. Given real client payments depend on this, a human
should look before/soon after this reaches production.

## Commits in scope (oldest → newest)

- `77dbe8f` Repair public lifecycle reconciliation and catchup
- `f9dad4f` Minimize reconciliation dry-run output
- `3a3c499` Default-disable public lifecycle sends
- `fd7fbf1` Harden public Stripe lifecycle reconciliation
- `3b9932e` Fail closed on incomplete Stripe evidence scans
- `4fd8aa3` Expose incomplete Stripe collection safely
- `cd413d9` Expose sanitized Stripe collection errors
- `1cbd4e9` Accept independently verified Stripe payment evidence
- `80b4480` Harden lifecycle email dispatcher claims
- `485dd32` Guard cancellations against active lifecycle dispatches
- `21ef26a` Expose safe conflicting payment evidence
- `acf22f8` Return authenticated reconciliation evidence
- `773fb63` Normalize unexpanded Stripe payment intents
- `810a2a3` Expose unbound matching payment evidence
- `a3ffaad` Read modern invoice payment intent evidence
- `fd65bab` Keep invoice evidence scan API-compatible
- `cbf063c` Deploy public lifecycle sender rollout
- `0b015af` Approve operator payment bindings and targeted lifecycle dispatch
- `cca81ed` Allow authenticated per-request targeting for lifecycle dispatch
- `bd04b2b` Resolve bound canonical payment through its fully observed PaymentIntent
- `afc94de` Resolve incomplete invoice evidence from the authoritative PaymentIntent and add dry-run diagnostic
- `bae9a58` Complete customer email on resolved invoice evidence from the verified intent chain
- `e3a61f8` Complete invoice customer email from the verified retrieve chain when the list row omits it
- `143a528` Merge complementary observations of a bound canonical payment, bound-object email wins
- `794333f` Default the booking date to the earliest bookable departure (booking-gating change, included because it touches the same booking path)

Files most affected: `app/api/cron/drip-emails/route.ts`,
`app/api/cron/drip-emails/reconcile/route.ts`,
`app/api/ops/bind-approved-payment/route.ts`, `lib/public-lifecycle.mjs`,
`lib/stripe-lifecycle-evidence.mjs`, plus three new Supabase migrations
(`20260915090000_lifecycle_dispatch_safety.sql`,
`20260915110000_guard_cancellation_lifecycle_dispatch.sql`,
`20260915120000_approved_payment_bindings.sql`).

## What a reviewer should confirm

- [ ] `PUBLIC_LIFECYCLE_SEND_ENABLED` and the new `PUBLIC_LIFECYCLE_TARGETED_*`
      env vars are set (or intentionally left unset) as expected on the
      production deploy — the code fails closed/disabled when they're absent,
      so nothing sends silently, but confirm that's the intended current state.
- [ ] The `approved_payment_bindings` / lifecycle-dispatch Supabase migrations
      have actually been applied to the production database.
- [ ] Spot-check a real booking's reconciliation result
      (`/api/cron/drip-emails?dry_run=1`) against the Stripe dashboard.
- [ ] Whether direct-to-`main` pushes for payment-critical code should go
      through a PR going forward.

## Booking-date gating note

`794333f` changes the default selected tour date on the booking form to the
earliest bookable scheduled departure, and an earlier commit in this window
collapses three legacy "private/2027" date labels into one
`Private group date on request` option (old stored values still normalize
correctly — covered by tests). Flagged here since it's booking-gating logic,
though it is not itself a Stripe/payment change.

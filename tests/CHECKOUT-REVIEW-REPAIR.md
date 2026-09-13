# Checkout review blockers — local repair evidence

Not released. No production SQL, email sends, provider mutations, push or deploy.

## Exact review boundary

Incremental repair starts from Site tree `336fcddf85079b9f017169b8fc318cfa7c4710e6`.
Paired Ops stays `3e1fc974e75349e8b31d5053432b54e4b02ce5fc` without edits.
Final frozen tree and archive checksums are recorded in `/tmp/8l-checkout-review-fixed-handoff.md`.
Original `/tmp/8l-booking-travellers-*` and canonical dirty work were not edited.

## Changes

- Recovery retrieves every authoritative ledger Session, requires provider `expired` / `unpaid`, checks Session identity, then authorizes the same generation under the booking lock. Open/complete/unknown/unavailable, missing/invalidated ownership, mismatched linkage and changed generations suppress sending. The cron injects the read-only Stripe retrieval boundary; absent credentials fail closed. The old authorization RPC returns false.
- Paid webhook retains the actual frozen pending Session amount but separately gates confirmation against current terms and adequate ledger net paid under the booking lock. A persistent commercial-terms fence records edits/reverts independently from ordinary payment invalidation. Confirmation and the bounded email lease are atomic; direct and Ops commercial edits are blocked during that lease.
- Booking paid balance uses the aggregate ledger, not whichever Session is reconciled last. Refund-first interleaving is covered.
- Every supplied client/metadata booking/public reference is checked literally before payment mutations.
- `20260913000000_checkout_review_fences.sql` is additive. No existing migration was rewritten.

## Rollout constraints / conservative behavior

Apply the new migration before deploying these callers. Old recovery authorization is intentionally disabled during mixed rollout. Keep recovery's explicit enablement switch off until provider/readback and release review are complete.

Existing generations are seeded `terms_invalidated=true`: their old invalidated flag cannot prove whether a historical edit occurred. Do not silently clear that fence. Existing ambiguous/non-owned payments are recorded but require manual confirmation review. New generations default false and are fenced on commercial changes. Already-completed paid/refunded replays remain no-ops with their frozen ledger amount despite changed due.

The universal payment trigger already takes the canonical booking lock; the new aggregate/confirmation RPC uses that same lock. Concurrent ledger writers must retain this contract. The five-minute lease exceeds the webhook's 60-second execution limit. This is database concurrency evidence, not proof that production has these migrations.

## Reproductions and verification

- `/tmp/8l-review-blockers-red.log`: actual recovery reaches the sender for open, complete, unknown/unavailable Sessions; zero provider reads; actual reference mismatch reaches payment mutation; status-only transition confirms edited terms.
- `/tmp/8l-review-blockers-sql-red.log`: real local PostgreSQL `REPRO: invalidated pending Session authorized reminder`.
- `/tmp/8l-edited-handler-red.log`: exact old handler confirms a $2,922 pending Session against current $4,000 booking due. `/tmp/8l-edited-handler-green.log`: actual payment retained, booking awaiting payment, manual-review event, zero confirmations, completed replay no writes.
- `/tmp/8l-payment-aggregate-red.log`: previous handler overwrites $4,000 aggregate with $2,922.
- `/tmp/8l-reference-conflicts-red.log`: additional literal/public-reference conflicts reach old mutation path.
- Site `npm test`: 190/190; `/tmp/8l-review-blockers-green.log`. Lint and production build pass in adjacent `-lint.log`, `-build.log`.
- Ops `npm test`: 178/178, unchanged tree; `/tmp/8l-review-paired-ops-tests.log`.
- `tests/review-blockers-runtime.sql`: invalidated recovery denied; old authorization denied; empty provider evidence denied; verified expiry accepted; edited underfunded booking not confirmed; actual money retained; sufficient current terms tested separately; edit/revert stays fenced; valid funded confirmation accepted; lease rejects direct price/count writes with subtransaction rollback.
- `tests/review-blockers-concurrency.py`: independent edit-first, confirmation-first, refund-first connections serialize correctly; fixtures cleaned. `/tmp/8l-review-blockers-concurrency.log`.
- `tests/review-migration-rollback.py`: full migration rollback on disposable local database clone restores predecessor functions/columns; commit creates new contract; clone dropped. `/tmp/8l-review-migration-rollback.log`.
- Existing traveller, booking email, shared-checkout and recovery SQL rollback suites pass. Existing recovery claim/cancellation concurrency and Ops record/audit rollback concurrency pass with fixtures updated for the stronger lease. `/tmp/8l-review-ops-concurrency.log`.
- Actual public/Ops cross-entrypoint local PostgreSQL suite: 8/8. `/tmp/8l-review-blockers-integration.log`. It reads original Ops implementation; verified paired Ops source equality in prior handoff, and this task did not change either Ops tree.

New tests isolate provider/email boundaries. No real Stripe read or email was performed. Browser suites were not rerun for this backend-only repair. Production schema/provider compatibility, rollout, independent re-review and live verification remain release gates.

# Payment dispatch / frozen issuance repair — local candidate, not release approval

Successor to Site `eef43718c77231269ea56db70da1a01812eaf745`; paired Ops remains `3e1fc974e75349e8b31d5053432b54e4b02ce5fc`. Frozen successor identity and archives are recorded outside the tree in `/tmp/8l-payment-dispatch-handoff.md`.

## Contract changes

- Frozen, ledger-bound Sessions validate count/date against per-payment issuance evidence rather than mutable booking terms. The additive migration snapshots exact matching ownership into existing payments and captures future issuance in a trigger. Later raw-event replacement preserves that snapshot even when ownership changes. Missing historical count evidence is not manufactured: the bound Session/payment relationship still records actual money, while current-term/ownership confirmation remains separately gated. Conflicting supplied booking/reference/customer identities, frozen count/date metadata, or ledger amount still reject before money mutation.
- Guest-count changes (up or down), date edits, higher or lower due retain the legitimate original payment and produce manual-review evidence without ordinary confirmation. Replays preserve the ledger and completed processing no-ops.
- Refund/ledger-loss writers take the booking lock and revoke the confirmation token **without blocking or discarding the refund**. A confirmation lease alone no longer authorizes sending.
- Immediately before each customer/internal send, the handler checks payment state and claims a durable, booking-locked dispatch journal row. Authorization rechecks the live token, current terms, ledger funding, and Session relationship. A final token/status read also suppresses a refund observable after dispatch authorization but before transport. The journal records accepted, failed, suppressed, or ambiguous dispatching outcomes and separately retains subsequent refund timestamps.
- Ambiguous dispatch is operator-review-only on recovery, not an unbounded retry relying on expired provider idempotency. Stable existing provider keys remain. An accepted dispatch whose later audit fails is not blindly sent again.

## Precise concurrency / provider boundary

The dispatch RPC is the durable **local authorization/ownership linearization point**, serialized with ledger writers under the booking lock. The last token read narrows the DB/network gap further. A refund committed before authorization, or observable at that final read, suppresses transport. Separate actual paid/refund handlers and PostgreSQL connections verify both windows.

There is still no atomic transaction spanning PostgreSQL and Resend: a refund committing after the last token read can race invocation/acceptance; a request already handed to transport cannot be recalled. Such a refund remains fully recorded, with `refund_observed_at` on the dispatch journal. The in-flight test deliberately proves this limitation (one accepted stub send, zero net funds, retained refund), rather than claiming distributed exactly-once or an impossible guarantee for every physical instruction between the final DB read and network invocation. If the release acceptance criterion literally forbids that residual window, this candidate does **not** meet that stronger criterion; reviewer/business must resolve it explicitly, not silently redefine provider acceptance as a database commit.

## Reproduction and real execution

- `/tmp/8l-final-red.log`: baseline exact independent probes and new failing count/refund assertions. Count edit leaves pending and zero money; refund after confirmation sends once; lease remains active.
- `/tmp/8l-final-independent-green.log`: **unchanged** `/tmp/8l-fixed-independent-probes.mjs` now records $2,922 with review for edited count, and sends zero after refund while retaining zero balance/refunded ledger. The unchanged Python bug probe now raises its original assertion because it asserts the vulnerable `active_confirmation_lease:true`; actual state is false. `tests/refund-dispatch-concurrency.py` keeps the same two-connection race and asserts the corrected false state, passes and verifies cleanup. Originals were not edited.
- `/tmp/8l-dispatch-final-boundary-red.log`: the added after-authorization/pre-transport refund assertion fails before the final token fence; subsequent real-handler suite passes.
- `npm test`: 196/196, `/tmp/8l-final-tests.log`; lint without warnings and optimized build pass, `/tmp/8l-final-{lint,build}.log`.
- Paired Ops `npm test`: 178/178, `/tmp/8l-final-ops-tests.log`; unchanged tree.
- `node --test tests/payment-dispatch-postgres.integration.mjs`: 12/12, `/tmp/8l-dispatch-runtime-green.log`. Actual handlers, real local PostgreSQL at localhost:55432/8l_test, only transport/analytics/email boundaries stubbed. Covers five commercial mutations, concurrent partial refunds/full convergence and replays, before/after dispatch fences, true in-flight refund, active processing replay, ambiguous provider recovery, immutable issuance after ownership/raw-event replacement. Fixture cleanup asserted.
- Existing review-blocker, traveller, initial-email, shared-checkout and abandonment SQL rollback suites pass: `/tmp/8l-final-runtime.log`.
- `python3 tests/dispatch-migration-rollback.py`: full new migration rollback then commit on a disposable clone, predecessor function/ledger snapshots unchanged; clone dropped. `/tmp/8l-dispatch-rollback.log`.

## Rollout / review gates

New migration only: `20260913010000_payment_dispatch_and_issuance.sql`, after the prior review-fences migration. No historical migration edits. Apply before new callers. Drain old webhook workers during rollout: old callers do not participate in dispatch authorization. Ops needs no source delta because its ledger writes participate in the universal trigger.

No production SQL, provider requests, email, push, deployment, or inquiry-worktree edits. Original/canonical dirty work preserved. Production schema compatibility, coordinated deployment, actual provider Session/readback verification, explicit recovery enablement, and independent exact-pair review remain separate release gates. No browser rerun claimed for this backend-only change.

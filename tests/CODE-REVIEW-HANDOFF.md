# Latest checkout UX and delayed recovery — local implementation

This section supersedes the pre-payment saved-tick and immediate scheduled customer-email descriptions below. No production release or independent approval is implied.

- Scheduled 1–8: durable pending intake, accessible “Preparing your secure checkout…” spinner, automatic exact Stripe handoff. No saved tick on form or private recovery page. Checkout failures retain entered details and the original private retry link; double submit is fenced. Private/unconfirmed requests receive neutral request wording, never automatic checkout.
- Scheduled intake no longer sends the immediate `booking_received` customer email. Internal notification retains the existing durable retry protocol; private requests retain their customer acknowledgment. Newsletter behavior is unchanged: optional explicit consent only; recovery never subscribes anyone.
- New canonical migration `20260910050000_abandoned_checkout_recovery.sql` follows the five existing unpublished feature migrations. An INSERT-only trigger enrolls new public intakes, with no backfill or historical money changes. Eligibility starts after one hour and ends after 48 hours. Current approved scheduled inventory, original date, awaiting-payment status, zero paid balance and absence of successful/refunded ledger activity are required. Claims and pre-send authorization use the booking row lock and the existing frozen email-payload/15-minute lease/token-fenced finalization protocol. Stable provider idempotency key; ambiguous attempts older than 23 hours require review.
- Authenticated `/api/cron/abandoned-checkouts` requires `CRON_SECRET` and exact `ABANDONED_CHECKOUT_RECOVERY_ENABLED=true`. Disabled by default. Vercel config schedules daily at 08:15 UTC (therefore reminders occur at the first daily run after the minimum delay, not exactly one hour). Batches are capped at 20; expired work is never caught up as a historical blast. No environment switch was enabled here.
- Recovery email is a single private transactional reminder, signed Rob Zaher, without names/manifest/DOB/marketing. Its link uses the existing script-free private recovery route; opening email/link does not create a Stripe Session. Payment link POST keeps shared public/Ops Checkout ownership.
- Race boundary: payment/cancellation already committed before claim or final pre-send authorization suppresses the email, including paid-ledger activity before balance reconciliation. Payment/cancellation occurring after authorization can still race the external email provider; this is not distributed atomicity. Email explicitly says to wait for confirmation instead of paying again if just paid, and actual checkout creation independently rejects paid/cancelled bookings.
- Upstream `09a9758d0c847a0c45772db543fc8b6b2b7bca5c` SEO changes were inspected and applied by clean three-way integration across all nine upstream files. Upstream deliberately noindexes the paid-search landing and removes it from sitemap; the stale local sitemap test was aligned, not the upstream product reverted. Prior staged baseline handles remain preserved: site `36d6ebd1f9e9b9351c7bea1e66440624555989c0`, Ops `3e1fc974e75349e8b31d5053432b54e4b02ce5fc`.

## Latest verification

- Site: 160/160 unit/route tests; lint and optimized build pass; production-dependency audit reports zero vulnerabilities.
- Ops untouched by this delta: 178/178 tests, lint and optimized build pass. Existing transactional Ops and shared ownership tests remain intact.
- Real Chrome 152 local production UI: all eight guest counts submit exact manifest cardinality and canonical displayed online amount; one intake/one automatic checkout; reduced motion; intake failure retains fields; checkout failure retains fields/private retry link; private request never calls checkout. External traffic and booking/provider boundaries are locally intercepted; no Stripe/customer/email call.
- Real Chrome CSP suite passes: actual private route POST/303 reaches locally intercepted Stripe origin, no Referer, arbitrary origins and inline scripts blocked.
- Real local PostgreSQL: all four runtime suites, existing independent-connection Ops races, eight public/Ops cross-entrypoint integration cases pass. New recovery independent-connection test proves one parallel claim winner and cancellation-first authorization suppression. Exact new migration replayed inside local BEGIN/ROLLBACK, including runtime assertions. Test fixture cleanup asserted. No remote SQL executed.

Repeat new checks: `psql -h /tmp -p 55432 -d 8l_test -v ON_ERROR_STOP=1 -f tests/abandoned-checkout-runtime.sql`; `python3 tests/abandoned-checkout-concurrency.py`; `PLAYWRIGHT_PATH=/tmp/8l-browser-tools/node_modules/playwright node tests/checkout-progress.browser.cjs` (local built site at 127.0.0.1:3318; install Playwright in that isolated temporary prefix, not product dependencies).

Evidence: `/tmp/8l-latest-{site-tests,site-lint,site-build,site-audit,ops-tests,ops-lint,ops-build,browser,csp-browser,sql,exact-migration}.log`. Initial expected RED evidence: `/tmp/8l-latest-red.log`, `/tmp/8l-latest-pay-red.log`; cron enabled-path regression also observed RED then repaired.

Still required separately: exact-tree independent review, deployment owner/Stripe capability, coordinated persisted migrations and deployments, actual provider Session amount/readback and live no-charge smoke. No commits/pushes/deployments/live mutations/customer emails/cards were performed by this implementation pass.

---

# Code-only safety re-review handoff

**Not release-approved. No commits, deployments, live database mutations, real Stripe Sessions, email sends or charges.** Existing staged work was preserved.

## Independent blockers addressed

1. **Shared public/Ops Checkout ownership.** Both real entry points call mirrored `lib/shared-booking-checkout.mjs`. `prepare_booking_checkout` locks the booking and owns one durable generation across both creators, freezing the first creator's exact provider payload (including public/Ops URL and metadata differences). Retry callers use that payload and provider key. Session expiry must be retrieved from Stripe before a generation advances. An unrecorded generation older than 23 hours requires operator reconciliation.
2. **Cancellation/ledger fencing.** Database triggers make booking financial/status/date/count changes and every payment insert/update/delete participate in the same booking lock. Competing pending Sessions and paid ledger activity invalidate the owned generation even before booking-balance reconciliation. `finalize_booking_checkout` checks the fence under that lock and atomically binds the Session plus pending row. A rejected finalization expires the provider Session and never returns its URL; ambiguous transport failures retain the same generation for retry. This is the URL-release linearization point, not a claim of distributed atomicity with Stripe. Later booking/payment changes fence future reuse; this is not a new background Stripe-expiration worker.
3. **Recoverable initial notifications.** Submission retries no longer return before email dispatch. The creation RPC compares the complete immutable canonical intake snapshot. Each notification has a frozen provider request, exclusive reclaimable lease, token-fenced finalization, and stable provider idempotency key. Sent notifications no-op. Failed or abandoned claims can resume within the provider window. Ambiguous attempts older than 23 hours become `review` with a failed `email_events` record; reconcile provider logs instead of blindly resending. This is submission-retry recovery, not an added cron consumer.
4. **Changed safety payloads.** DOB, nationality, riding experience, dietary notes, phone, emergency contact, customer/waiver notes, booking notes and the entire normalized manifest are included in the original snapshot. Changed retries return HTTP 409 with explicit “changes have not been saved” wording, not a saved tick.

Prior transactional Ops record updates, exact scheduled 1–8 pricing, companion manifests, request-only/custom gating, private recovery headers, and saving UX remain intact.

## Migration/deployment contract

Canonical migrations remain in the site repository. Apply only the reviewed feature migrations, in order, after the existing schema/confirmation-lease/family-cash prerequisites:

1. `20260910000000_booking_travellers.sql` — now includes immutable intake payload.
2. `20260910010000_ops_record_transaction.sql`.
3. `20260910020000_public_checkout_attempts.sql` — original unpublished generation schema.
4. `20260910030000_shared_checkout_ownership.sql` — supersedes/revokes the public-only preparation RPC.
5. `20260910040000_initial_booking_notifications.sql`.

All five remain **unpublished release work**. Existing initial-email v1 records, if any are found during a future rollout, are not automatically resent by v2; reconcile them explicitly. Missing original submission payloads fail closed rather than pretending an edited retry was saved. Coordinate deployment of both creators; an old Ops creator does not implement this protocol. Disable creation during any mixed-version rollout rather than claiming old code is coordinated. Do not broad-push unrelated inquiry migrations.

## Repeatable local verification

- Site: `npm test`, `npm run lint`, `npm run build`.
- Ops: `npm test`, `npm run lint`, `npm run build`.
- Local PostgreSQL only, port 55432 / database `8l_test`, with the above schema installed:
  - `python3 tests/ops-record-concurrency.py`
  - `psql -h /tmp -p 55432 -d 8l_test -v ON_ERROR_STOP=1 -f tests/booking-travellers-runtime.sql -f tests/shared-checkout-runtime.sql -f tests/booking-email-runtime.sql`
  - `node --test tests/shared-checkout-postgres.integration.mjs`

The integration suite transpiles and executes **both actual application entry points and each repo's actual shared orchestrator**, using a local PostgreSQL Supabase transport adapter and an in-memory Stripe boundary. It covers public-first and Ops-first overlap, frozen provider payload/key sharing, and cancellation/paid/foreign-pending races for each creator. It asserts fixture removal. It is not evidence of a real Stripe account or Session.

`REVIEW_BASELINE=1 node --test tests/shared-checkout-postgres.integration.mjs` replays the original reviewed TypeScript entry points from exact trees `2c7410d9a2bbf1100b1f025ff34420dc788c7104` / `5bd7aaacc655f1bec99e3506065b082e81e0df25` against the same local transport: the original public/Ops overlap produced two Sessions, and original public paid/foreign-pending races returned a URL. Separate RED SQL reproduced silently discarded DOB changes, and RED route tests reproduced skipped initial notifications on retry before fixes.

The Python suite retains actual independent-connection lock-wait tests for stale Ops edits and audit rollback/payment ordering, plus concurrent shared generation preparation and bounded retry checks. Runtime SQL exercises complete group manifests, safety payload conflicts, shared ownership/fencing/expiry, email lease exclusion, frozen retry payloads, stale finalization and finite provider-key lifetime.

## Still separate / unverified

Independent exact-tree re-review, production compatibility and persisted migrations, Vercel owner-scope access/configuration, actual Stripe create/retrieve/expire evidence, and live saving/payment/recovery UX. The parent is resolving access separately. No release approval is implied by local passes.

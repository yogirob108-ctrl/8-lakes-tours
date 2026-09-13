# Atomic Ops deletion successor (local review candidate)

Predecessors: Site `3da2edc863e6299fb2312fea28b39a4e26786382`, Ops `3e1fc974e75349e8b31d5053432b54e4b02ce5fc`.

## Repair

The payment DELETE trigger revoked the token that both Ops deletion entry points used as deletion ownership. Both could strip children and report success with the parent still present. The API DELETE also lacked project scoping.

New additive `20260913020000_atomic_ops_booking_delete.sql` owns a transaction-scoped, project/ID/reference-bound booking row lock. It does NOT claim any payment-confirmation token, change the refund trigger, or weaken refund/dispatch revocation. A live confirmation lease (including unknown timestamp) or an unresolved `dispatching` journal prevents deletion. Expired leases alone can be reclaimed; ambiguous provider acceptance requires review, not a timed blind delete.

The RPC deletes booking email events (their FK is SET NULL) and then deletes the parent with RETURNING and row-count proof. All other children cascade. Exceptions and trigger-suppressed parent deletion roll back the entire transaction, including prior email deletion. Customer identity survives. Both actual Ops server action and API DELETE call this RPC and require the exact deleted booking ID before reporting success. There is no multi-request child-delete fallback.

No production data, invoices, provider endpoints or customer emails were touched. Stubbed email transport is used only in disposable local test fixtures. SQL fixture cleanup is checked.

## Tests / reproducibility

Local PostgreSQL fixture database is explicitly `postgresql://localhost:55432/8l_test`. Apply the predecessor migrations in order, then the new migration. Do not point these scripts at production. Run SQL/DB integrations serially (fault-injection triggers are global but fixture-ID guarded).

From Ops:
- `node --test tests/booking-delete-postgres.integration.mjs` — **28/28**: actual action and API against PostgreSQL, pending/paid ledgers and every original child, customer retained, auth, scope triple mismatch, active/missing/stale lease, revoked-token unresolved dispatch, stale lookup / no-row conflict, malformed RPC proof, parent exception, parent trigger returning NULL, child exception, complete rollback, anon/authenticated permission denial.
- `npm test` — **178/178**; `npm run lint`; `npm run build` — pass.

From Site:
- `OPS_DELETE_ROOT=/tmp/8l-checkout-audit-ops node --test tests/booking-delete-handler.integration.mjs` — **15/15**, including all **12** prior actual paid/refund-handler cases and **3** pair-bound actual Ops-action races: confirmation-first/refund, dispatch-first/revocation, deletion-first/replay. No sends after deletion or confirmation-first refund; in-flight accepted dispatch remains documented, not recalled.
- `python3 tests/booking-delete-concurrency.py` — five independent-connection cases with observed locks: deletion-first, confirmation-first, double-delete, refund-first, deletion rollback.
- `python3 tests/booking-delete-migration-rollback.py` — disposable clone DDL rollback/commit, exact catalog function body, predecessor confirmation/refund/dispatch functions and ledger unchanged.
- `python3 tests/review-blockers-concurrency.py`; `python3 tests/refund-dispatch-concurrency.py` — pass.
- Five `psql ... -X -v ON_ERROR_STOP=1 -f tests/<name>` rollback suites pass: review-blockers-runtime.sql, booking-travellers-runtime.sql, booking-email-runtime.sql, shared-checkout-runtime.sql, abandoned-checkout-runtime.sql.
- `npm test` — **196/196**; `npm run lint`; `npm run build` — pass.

RED evidence: `/tmp/8l-delete-red.log` (11 failures/13; original actual action falsely succeeded and left parent on pending AND paid). Second TDD cycle `/tmp/8l-delete-api-red.log` (7 API failures/28, same stripped-parent defect plus project-scope failure). GREEN `/tmp/8l-delete-green.log` (28/28); prior refund/dispatch + cross-action `/tmp/8l-delete-cross-handler.log`; suites `/tmp/8l-delete-{site,ops}-{suite,lint,build}.log`; SQL `/tmp/8l-delete-sql-suites.log`.

## Release remains separate

Apply migration before both new Ops callers; pause/drain old Ops deletion workers because an old multi-request action is not made atomic by a new RPC. Retain the prior coordinated Site webhook drain requirement. Historical migration bytes and refund/dispatch production code remain unchanged. Existing stripped rows, if any, need a separately authorized backup/audit recovery; this patch does not reconstruct deleted history or authorize production data repair.

Independent review of the newly frozen pair is required. The prior final observable DB read / external provider network gap is unchanged; no distributed exactly-once claim. Production schema compatibility, environment/config/auth, provider Session evidence, recovery enablement, deployment, live smoke and combined inquiry integration remain unverified.

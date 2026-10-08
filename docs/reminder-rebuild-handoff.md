# Abandoned checkout reminder rebuild handoff

## Scope and safety state

This repair is **not activated**. The migration makes post-submit reminder enrollment forward-only. It does not send customer email, modify production data, configure a scheduler, alter provider state, or change any environment value.

An explicit first activation records one durable watermark. Only bookings inserted while the rollout is `forward` are enrolled with their recovery row, booking-specific activation record, and stage-2 binding. Existing recovery rows remain untouched and remain excluded from automatic forward enrollment. Stage 2 requires all three matching durable records.

**Important operational boundary:** this is a continuing forward cohort, not an SQL-enforced count-limited cohort. While `mode = forward`, eligible newly inserted checkouts continue to enroll. The queue itself has a maximum batch of 20 per invocation, which is not a customer-cohort limit. For a small first cohort, the owner must define a time window or observed count and pause the rollout/scheduler after it; no code here performs that operational pause automatically.

## Required release order

1. Apply `supabase/migrations/20260919110000_abandoned_checkout_forward_enrollment.sql` first, while the existing customer-send controls remain in their current safe state. This is compatible with the already-deployed legacy route because the durable database gate stays `off`; it prevents the old trigger from creating new recovery rows before the new web build arrives. Read back:

   ```sql
   select mode, activation_ref, activation_watermark
   from public.abandoned_cadence_rollout where one_row;
   ```

   Required pre-activation result: `mode = off`, `activation_ref IS NULL`, and `activation_watermark IS NULL`.
2. Deploy the reviewed application/scripts. Keep `ABANDONED_CHECKOUT_RECOVERY_ENABLED=false` until the owner approves activation. **Do not change `PRE_SUBMIT_DRAFT_RECOVERY_ENABLED`**: it is a separate existing control, and this repair neither enables nor disables it.
3. Run the authenticated production **dry run only** (no customer sends), supplying the secret via stdin config rather than a curl argument:

   ```bash
   curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 55 --config - <<EOF
   header = "Authorization: Bearer ${CRON_SECRET}"
   header = "Accept: application/json"
   url = "https://www.8lakestours.com/api/cron/abandoned-checkouts?dry_run=1"
   EOF
   ```

   Confirm `sent: 0`; inspect both `draft_recovery` and post-submit suppression/eligibility output. Do not use an unscoped or non-dry run at this step.
4. The scheduler is already installed as `/Users/kokos/.hermes/scripts/8l_reminder_tick.py` under Hermes cron job `003e29361e29`, every 5 minutes, **paused**. The parent verified the job. Do not create a second scheduler or reactivate it as part of this change.
5. Keep job `003e29361e29` paused until owner approval. Its installed Python scheduler already enforces the 5-minute cadence, 55-second timeout, HTTPS endpoint, single-process lock, header-free output, and pause control.
6. After owner approval, set `ABANDONED_CHECKOUT_RECOVERY_ENABLED=true` on the deployed site and read it back using the authenticated non-dry endpoint. This does not imply any pre-submit-draft change.
7. Immediately before the agreed first fresh-checkout window, call the service-role activation RPC with a unique audited reference:

   ```sql
   select public.abandoned_cadence_activate_forward('8L-REMINDER-ROLLOUT-<change-id>');
   ```

   The same reference is idempotent while already forward. If operations pause by setting the rollout mode to `off`, resume only the recorded boundary:

   ```sql
   select public.abandoned_cadence_resume_forward('8L-REMINDER-ROLLOUT-<same-change-id>');
   ```

   A different reference, or a fresh activation after a watermark exists, is refused. Read back the rollout row after every activation/resume. Do not activate until the send gate, dry-run evidence, and scheduler replacement are ready.
8. Enable the scheduler and observe the agreed bounded operational window. Verify each provider-accepted send against `email_events`, `public_booking_notifications`, recovery `stages`, and the exact booking reference before continuing.

## Installed scheduler contract

The removed shell-wrapper instruction is obsolete. Hermes cron job `003e29361e29` invokes the installed `/Users/kokos/.hermes/scripts/8l_reminder_tick.py`; it is paused and must stay paused until approved activation. That script pins the endpoint, reads `CRON_SECRET` from Hermes secret storage without argv exposure, rejects redirects/non-2xx outcomes, and uses one local lock. Do not add another scheduler or execute a repository wrapper.

## Verified locally

- Installed Python scheduler is documented as the sole paused 5-minute job; no repository shell wrapper is required.
- Clean isolated PostgreSQL rehearsal proves pre-activation bookings receive no recovery row; post-activation bookings get recovery and all matching bindings atomically; same-ref activation is idempotent; pause/resume preserves the original watermark; changing the reference is refused.
- Existing SQL suites pass for the one-hour eligibility gate, stage 2 at least 24 hours after durable stage-1 completion, maximum two sends, dry-run zero claims/sends, paid/cancelled suppression, request-only exclusion, provider-block/unknown-outcome handling, and legacy-history fencing.

Commands run:

```bash
bash tests/run-abandoned-checkout-reminder.test.sh
bash tests/rebuild-8l-test.sh
psql -X -U postgres -v ON_ERROR_STOP=1 -d 8l_test -f tests/abandoned-checkout-forward-enrollment-runtime.sql
psql -X -U postgres -v ON_ERROR_STOP=1 -d 8l_test -f tests/abandoned-checkout-runtime.sql
psql -X -U postgres -v ON_ERROR_STOP=1 -d 8l_test -f tests/abandoned-cadence-gates-runtime.sql
```

The PostgreSQL rehearsal used a disposable local PostgreSQL 17 cluster on port 55432. It was not production-connected; runtime suites roll back their fixtures.

# Abandoned checkout reminder rebuild handoff

## Scope and safety state

This repair is **not activated**. It makes post-submit reminder enrollment forward-only and preserves both customer-send controls as false unless an operator explicitly sets them. It does not alter GA4, cash-due logic, pre-submit draft behavior, production data, provider state, environment variables, scheduler configuration, or Vercel plan.

The database migration adds a durable activation watermark. Before that watermark, newly inserted bookings do not receive `abandoned_checkout_recovery` rows and cannot be admitted later by turning on the gate. After a single explicit forward activation, only bookings inserted after it are atomically enrolled with:

- their recovery row;
- a booking-specific activation-log binding; and
- the matching stage-2 cohort binding.

Stage 2 requires the same booking and activation reference in all three durable records. Existing recovery/legacy-email history is retained but cannot enter the forward cohort.

## Required release order

1. Merge the reviewed commit and deploy it with both environment flags unset or `false`:
   - `ABANDONED_CHECKOUT_RECOVERY_ENABLED=false`
   - `PRE_SUBMIT_DRAFT_RECOVERY_ENABLED=false`
2. Apply `supabase/migrations/20260919110000_abandoned_checkout_forward_enrollment.sql` using the normal production migration role. Read back:

   ```sql
   select mode, activation_ref, activation_watermark
   from public.abandoned_cadence_rollout where one_row;
   ```

   Required result before any cohort decision: `mode = off`, `activation_ref IS NULL`, and `activation_watermark IS NULL`.
3. Run the authenticated production **dry run only** (no customer sends):

   ```bash
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $CRON_SECRET" \
     'https://www.8lakestours.com/api/cron/abandoned-checkouts?dry_run=1'
   ```

   Confirm `sent: 0`; inspect both `draft_recovery` and post-submit suppression/eligibility output. Do not use an unscoped or non-dry run at this step.
4. Arrange the external scheduler below, initially paused. Vercel currently declares this route only once daily (`15 8 * * *`); that cadence cannot reliably produce a one-hour reminder. Do not change a Vercel plan or assume subdaily cron availability.
5. After owner approval of a bounded fresh-booking cohort, set `ABANDONED_CHECKOUT_RECOVERY_ENABLED=true` in the deployed site **and read it back through the authenticated non-dry endpoint**. This does not enable pre-submit drafts.
6. Immediately before accepting the first fresh checkout, call the service-role RPC once with a unique audited reference:

   ```sql
   select public.abandoned_cadence_activate_forward('8L-REMINDER-ROLLOUT-<change-id>');
   ```

   This is irreversible by design without an explicit migration/rollback decision. Then read back its returned timestamp and the rollout row. Do not call it before the customer-send gate, dry-run evidence, and scheduler are ready: bookings inserted afterwards are the only enrolled cohort.
7. Enable the external scheduler. Observe only a bounded first cohort, then verify each provider-accepted send against `email_events`, `public_booking_notifications`, recovery `stages`, and the exact booking reference before expanding operations.

## External scheduler contract

Use a managed scheduler that can inject secrets (for example GitHub Actions environment secrets, Cloud Scheduler secret-backed job, or an ops-controlled runner). Configure it to execute this repository script **hourly**, with no secrets in the command, source, logs, or URL:

```bash
REMINDER_CRON_URL='https://www.8lakestours.com/api/cron/abandoned-checkouts' \
CRON_SECRET="$INJECTED_SECRET" \
bash scripts/run-abandoned-checkout-reminder.sh
```

The scheduler must enforce: HTTPS destination only; `CRON_SECRET` from its secret store; 55-second request timeout; non-2xx exits treated as failed/retried; one concurrent invocation maximum; logs retained without request headers; and a pause switch. The endpoint itself validates the bearer token and retains SQL claim/authorization/idempotency/provider-evidence guards. No Hermes cron was created.

## Behavioral verification completed locally

- Node behavior tests prove post-submit and pre-submit flags are independent, and a credentialed dry run can observe both while both send gates are false.
- SQL migration rehearsal from a clean PostgreSQL cluster proves: default-off pre-watermark booking gets no recovery row; explicit forward activation creates a watermark; a post-watermark booking receives recovery, activation, and stage-2 bindings in one transaction; the old booking remains excluded.
- Existing runtime suites pass for stage-1 delay, stage-2 >=24 hours after durable stage-1 completion, maximum two sends, dry-run zero claims/sends, exact provider-session evidence, paid/cancelled suppression, request-only date exclusion, provider-block/unknown-outcome handling, and legacy-history fencing.

Commands run:

```bash
npm test
bash tests/rebuild-8l-test.sh
psql -X -v ON_ERROR_STOP=1 -d 8l_test -f tests/abandoned-checkout-forward-enrollment-runtime.sql
psql -X -v ON_ERROR_STOP=1 -d 8l_test -f tests/abandoned-checkout-runtime.sql
psql -X -v ON_ERROR_STOP=1 -d 8l_test -f tests/abandoned-cadence-gates-runtime.sql
```

The PostgreSQL rehearsal used a disposable local cluster and every runtime suite rolls back its fixtures.

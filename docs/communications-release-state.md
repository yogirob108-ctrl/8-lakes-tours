# Communications rebuild release state

## Database
Both reviewed migrations were applied transactionally to production project `izomzgseckrweydevsff` and read back:
- `20260919110000_abandoned_checkout_forward_enrollment`
- `20260924010000_external_email_attestations`

Production function definitions were captured before modification and checked for drift inside the transaction. The exact transaction passed a disposable PostgreSQL rehearsal with captured live functions, live token column types, and broad default grants before application. No customer rows were changed by these migrations. The attestation RPC is service-role-only; anonymous execute was independently read back as false.

## Not activated
Production database reminder mode remains `off`. The website authenticated dry run reports `post_submit_enabled=true`, `pre_submit_draft_enabled=false`; zero sends occurred. Do not interpret the app flag alone as activation.

A script-only default-profile Hermes job `003e29361e29` is installed at five-minute cadence and is **paused**. Runner source: `scripts/reminder-scheduler-tick.py`; deployed runner: `~/.hermes/scripts/8l_reminder_tick.py`. Credentials are read privately from the existing website cron file. No LLM is involved; successful ticks are silent and failed ticks alert the originating chat. This runner depends on the Mac/gateway having network access; outages delay reminders. The server's existing daily Vercel invocation remains unchanged as a fallback; shared SQL claims prevent duplicate sends, but it is not a five-minute SLA.

## Verification
- Website Node suite: 333 passing.
- Attestation runtime: 17 real PostgreSQL tests, including concurrent retry and observed row-lock races; passed with both clean-migration and captured live token types.
- Shell runner mock-curl test passed. Python runner response validation tests passed.
- No controlled customer send has been executed in this release.

## Pending
Finish and review Ops production-component browser tests, deploy Ops, verify authenticated booking display. Activation of future-only checkout reminders is a separate explicit step after release verification; pre-submit reminders remain separate. No historical reminder audience should be enrolled.

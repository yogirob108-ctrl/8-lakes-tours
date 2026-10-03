# Full-trip lifecycle audit — 2026-10-01

Read-only audit. No booking status, payment, email-event, sender-owner, or feature-flag writes were made.

## Evidence and counts

- Linked Supabase read: **11** booking rows: **10** non-cancelled and **1** cancelled.
- Live Stripe reconciliation dry-run: **10 checked**, complete scan, **6 verified_paid**, **2 no_verified_payment**, **2 review_ambiguous_unbound_evidence**.
- Current public lifecycle dry-run: **10 checked**, complete Stripe scan; `PUBLIC_LIFECYCLE_SEND_ENABLED=true`, `POST_TRIP_EMAIL_ENABLED=false`, and public post-trip ownership is false. It sent nothing.
- The dry-run's previously-null payment diagnostic date fields are absent provider fields, not evidence that the six verified payments failed date parsing.

## Per-booking artifact

| Reference | Status / end-date source | Stripe reconciliation | Existing lifecycle/email history | Post-trip schedule and next due |
| --- | --- | --- | --- | --- |
| 8L-1F2F5 | `prep_sent`; label fallback end 2027-06-13 | `review_ambiguous_unbound_evidence` | `preparation_packing:sent` | Future; no action now. |
| 8L-4YPP9 | `prep_sent`; linked departure 2026-08-12 | `verified_paid` | `payment_confirmed`, `preparation_packing`, `insurance_final_check`, `post_trip_followup`: sent | Legacy follow-up suppresses referral; none. |
| 8L-5DX8R | `cancelled`; no linked end | Not included in the 10-row lifecycle scan | `payment_confirmed`, `preparation_packing`, `insurance_final_check`: sent | Excluded, regardless of label/date. |
| 8L-CRBP3K8 | `confirmed`; linked departure 2026-10-01 | `verified_paid` | dispatch: payment sent 9/21; preparation failed 9/22 then sent 9/23. Email history also has final checklist sent. | End today; referral earliest 2026-10-04 after migration/owner/flag release. |
| 8L-CWDP2 | `prep_sent`; linked departure 2026-10-01 | `review_ambiguous_unbound_evidence` | final checklist and earlier lifecycle emails sent | End today, but provider evidence must be resolved; no automatic post-trip email. |
| 8L-E7GXJ | `prep_sent`; linked departure 2026-07-14 | `verified_paid` | `post_trip_followup:sent` plus payment/preparation/insurance sent | Legacy follow-up suppresses referral; none. |
| 8L-GDFH3 | `confirmed`; linked departure 2026-10-01 | `verified_paid` | dispatch: payment/preparation/insurance sent; six insurance failures 9/17–22 then sent 9/23. Final checklist sent. | End today; referral earliest 2026-10-04 after migration/owner/flag release. |
| 8L-LEG-HB | `confirmed`; no linked end; `7 June - 15 June` has no year | `no_verified_payment` | final checklist failed | Fail closed: unknown/yearless date and no verified payment; none. |
| 8L-LEG-SY | `confirmed`; no linked end; `July 16th - 24th` has no year | `no_verified_payment` | `post_trip_followup:sent` | Fail closed; legacy follow-up also suppresses referral. |
| 8L-M8MCN | `prep_sent`; linked departure 2026-09-22 | `verified_paid` | payment/preparation/insurance sent; final checklist failed | Within 3–30-day window (day 9): next due immediately after migration/owner/flag release. |
| 8L-WZXNF | `prep_sent`; linked departure 2026-08-12 | `verified_paid` | payment/preparation/insurance sent | Day 50: outside 30-day cutoff; none. |

## Migration-history reconciliation

- Live `claim_lifecycle_email_dispatch` was read back before writing the successor migration. It currently restricts `post_trip_referral` to `completed` and retains the post-trip owner lock.
- `supabase_migrations.schema_migrations` has no records for `20261001000000`, `20261001010000`, or `20261002010000`, although the first two functions/tables are live. No history row was inserted and no live SQL was re-applied.
- `20261002010000_automatic_post_trip_eligibility.sql` is a migration-first successor: it preserves the verified claimant/owner/lease/deduplication behavior and changes only the post-trip status guard to `confirmed`, `prep_sent`, `ready_for_departure`, or `completed`. Paid/refund evidence remains the read-only Stripe reconciliation gate in the sender.

## Public/Ops overlap risk

The shared claimant takes the booking lock and, for post-trip, the single sender-owner row lock. The public sender cannot claim while owner is legacy; legacy and public keys cross-suppress through `post_trip_followup` / `post_trip_referral`. The concrete remaining release risk is operational: enabling public ownership or the flag before this migration/deployment is present leaves the live claim guard completed-only. No automated overlap was observed or exercised because the public owner remains false.

## Hermes reminder job

Local scheduler metadata shows job `003e29361e29` is enabled, scheduled every five minutes, with 1,437 completed runs and last status `ok` at 2026-10-01T14:25:22+02:00. Local historical logs show silent successful runs. This is local metadata/history only; it is not a Vercel deployment claim.

## Release handoff — 2026-10-01

- PR #74 is merged. The production database has the exact `20261002010000` successor applied; its post-trip status guard admits non-cancelled `confirmed`, `prep_sent`, `ready_for_departure`, and `completed` bookings. Paid/refund eligibility remains in the sender’s Stripe reconciliation. The owner row remains `legacy`; `POST_TRIP_EMAIL_ENABLED` remains false.
- Authenticated production dry-run at release confirmed one current candidate: `8L-M8MCN` (`post_trip_referral`), with no send. `8L-CRBP3K8` and `8L-GDFH3` become date-eligible on 2026-10-04; `8L-CWDP2` remains excluded pending payment-evidence resolution. Yearless legacy labels remain excluded.
- Do not enable public ownership or the post-trip flag in this release. When Rob has Vercel flag access, perform the separately authorized activation no earlier than **2026-10-04 08:00 UTC**: read back `POST_TRIP_EMAIL_ENABLED=true`, public owner, and the same authenticated dry-run before allowing a non-dry run.
- Migration history still lacks exact semantic catalog entries for the older Oct 1 objects. No old DDL was replayed and no history metadata was repaired; this remains a metadata-reconciliation gap.

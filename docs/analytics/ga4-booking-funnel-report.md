# GA4 booking-funnel report

Run the real, ordered GA4 Data API funnel (no Measurement Protocol event is sent):

```sh
python3 scripts/ga4_funnel_report.py \
  --credentials /absolute/path/to/service-account.json \
  --start-date 90daysAgo --end-date today \
  --output artifacts/ga4-booking-funnel-90d.json
```

The script is deliberately locked to 8 Lakes GA4 property `535539074`. It issues two
`properties.runFunnelReport` reads: one overall and one broken down by
`sessionSourceMedium`. It returns GA4 aggregate funnel rows only, never customer
identifiers or raw booking references.

## Current report — 2026-11-06 17:16 UTC

Period: `90daysAgo` through `today`, queried directly from GA4 Data API.

| Ordered stage | Active users | Completion to next stage |
| --- | ---: | ---: |
| Booking form started | 44 | 3 (6.82%) |
| Booking form submitted | 3 | 0 (0%) |
| Checkout session created | 0 reported | — |
| Checkout redirect started | 0 reported | — |
| Paid — server-confirmed `payment_received` | 0 reported | — |

No `view_tour` or `booking_cta_click` rows appear because these consent-safe stages
were added in PR #86 and were not yet in production at the time of this read. The
same applies to new checkout stages. `payment_received` remains the only paid
conversion and is server-emitted after an actual confirmed payment; it is not
synthesized for this report.

Source rows for the two observed ordered stages were: `chatgpt.com / ai-assistant`
(17 form starts, 1 submit), `(direct) / (none)` (7 starts, 0 submits), `google /
organic` (5 starts, 1 submit), `m.facebook.com / referral` (5 starts, 0 submits),
and `google / cpc` (3 starts, 1 submit). The remainder is aggregate/suppressed or
other low-volume sources. These figures are GA4 funnel users, not arithmetic
subtraction of independent event totals.

### Interpretation limits

- This is an **open, ordered** funnel. A person can enter at a later stage; do not
  treat it as a reconstruction of every visitor's path.
- GA4 reporting is processed and can lag. It is not a booking, Stripe, or email
  ledger.
- Consent Mode is preserved: optional analytics storage defaults to denied, and
  paid conversion attribution is emitted only when the real payment has a consented
  GA client ID. No historical conversions were replayed.
- The checked-in instructions are safe to share; generated JSON belongs in the
  ignored `artifacts/` directory.

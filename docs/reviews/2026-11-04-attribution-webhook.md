# Review flag: booking attribution + Stripe webhook (2026-11-04)

Commits on main by Henry Willmott / srrenneh (not the routine's account): 19741be, a8c39b7, 38f41ed.

Needs a human second look before/while live:
- app/api/stripe/webhook/route.ts: GA client/session ID now read from bookings.submission_payload (with legacy notes fallback); bookingSelect now selects submission_payload. No change to amounts, status transitions or signature checks.
- app/api/bookings/route.ts: now calls create_public_booking with new p_attribution arg. DEPLOY ORDER: migration 20261103000000_booking_attribution_payload.sql must be applied to Supabase BEFORE this code is live, or every booking RPC call fails.
- Homepage pricing card copy changed (display only; pricing math unchanged).
- No changes to trip date / booking gating logic, env vars, or Formspree config found.
- Tests: 18 failing locally both before and after these commits (dependencies not installed in the sandbox) - no regression detected, but CI should confirm.

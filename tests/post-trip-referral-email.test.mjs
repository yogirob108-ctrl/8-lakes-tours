import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { daysSinceTourEnd, selectPostTripCandidate, POST_TRIP_TEMPLATE } from '../lib/post-trip-email.mjs';
import { reconcileStripeProviderEvidence, selectPacedLifecycleCandidate } from '../lib/public-lifecycle.mjs';

const dates = [
  { date: 'September 14 – 22, 2026', startDate: '2026-09-14', endDate: '2026-09-22' },
  { date: 'Private group date on request', requiresConfirmation: true },
];
const pick = (days, overrides = {}) => selectPostTripCandidate({ enabled: true, verifiedStripe: true, daysSinceEnd: days, sentTemplates: new Set(), ...overrides });

test('days since the end prefer the linked departure and otherwise parse only an explicit-year historical label', () => {
  const now = new Date('2026-09-25T20:00:00Z');
  assert.equal(daysSinceTourEnd('anything', now, dates, '2026-09-22'), 3);
  assert.equal(daysSinceTourEnd('September 14 – 22, 2026', now, dates), 3);
  assert.equal(daysSinceTourEnd('Sep 23 - Oct 1, 2026', new Date('2026-10-04T00:00:00Z'), dates), 3);
  assert.equal(daysSinceTourEnd('Private group date on request', now, dates), null);
  assert.equal(daysSinceTourEnd('7 June - 15 June', now, dates), null);
  assert.equal(daysSinceTourEnd('July16th-24th', now, dates), null);
  assert.equal(daysSinceTourEnd('September 14 – 22 2026', now, dates), 3);
});

test('the thank-you goes out 3 to 30 days after the trip, once, to paid guests only', () => {
  assert.equal(pick(2), null);
  assert.equal(pick(3), POST_TRIP_TEMPLATE);
  assert.equal(pick(30), POST_TRIP_TEMPLATE);
  assert.equal(pick(31), null);
  assert.equal(pick(-5), null);
  assert.equal(pick(null), null);
  assert.equal(pick(5, { verifiedStripe: false }), null);
  assert.equal(pick(5, { sentTemplates: new Set([POST_TRIP_TEMPLATE]) }), null);
});

test('invalid and yearless dates fail closed before the 3–30-day selector', () => {
  const now = new Date('2026-10-04T00:00:00Z');
  assert.equal(selectPostTripCandidate({ enabled:true, verifiedStripe:true, daysSinceEnd:daysSinceTourEnd('July16th-24th', now), sentTemplates:new Set() }), null);
  assert.equal(selectPostTripCandidate({ enabled:true, verifiedStripe:true, daysSinceEnd:daysSinceTourEnd('September 31 - October 2, 2026', now), sentTemplates:new Set() }), null);
});

test('refunded evidence never becomes a post-trip candidate and future pre-trip scheduling is unchanged', () => {
  const reconciliation = reconcileStripeProviderEvidence({
    bookings:[{ id:'booking', reference:'8L-REFUND', amount_cents:99900, currency:'usd', customer_email:'guest@example.test' }],
    evidence:[{ id:'pi_refund', reference:'8L-REFUND', amount_cents:99900, currency:'usd', customer_email:'guest@example.test', payment_intent_status:'succeeded', charge_amount_cents:99900, charge_amount_refunded_cents:99900 }],
    scanComplete:true,
  });
  assert.equal(reconciliation[0].status, 'review_refunded_or_partial');
  assert.equal(pick(5, { verifiedStripe: reconciliation[0].status === 'verified_paid' }), null);
  assert.equal(selectPacedLifecycleCandidate({ verifiedStripe:true, daysUntilDeparture:10, sentTemplates:new Set(['payment_confirmed','preparation_packing','insurance_final_check']) }), 'arrival_coordination');
});

test('the email states the agreed $100 each way and how to claim it', async () => {
  const source = await readFile(new URL('../lib/email.ts', import.meta.url), 'utf8');
  assert.match(source, /export const REFERRAL_REWARD_USD = 100;/);
  assert.match(source, /pay \$\{reward\} less on the in-person portion to the host family/);
  assert.match(source, /we send \$\{reward\} back to you once their booking is confirmed/);
  assert.match(source, /write your name in the notes when they book/);
});

test('the thank-you asks for a Google review with the profile link, in text and HTML', async () => {
  const source = await readFile(new URL('../lib/email.ts', import.meta.url), 'utf8');
  assert.match(source, /export const GOOGLE_REVIEW_URL = 'https:\/\/g\.page\/r\/CXxsi41trR1yEAE\/review';/);
  assert.equal(source.match(/Leave us a Google review\./g)?.length, 2);
  assert.equal(source.match(/more steady work for the family who hosted you/g)?.length, 2);
});

test('the daily job reads automatic post-trip statuses with a linked departure end date and supports a dry-run-only preview', async () => {
  const source = await readFile(new URL('../app/api/cron/drip-emails/route.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.POST_TRIP_EMAIL_ENABLED === 'true'/);
  assert.match(source, /postTripPreview = dryRun && url\.searchParams\.get\('post_trip_preview'\) === '1'/);
  assert.match(source, /postTripEligible = postTripEnabled \|\| postTripPreview/);
  assert.match(source, /departure:departures\(end_date\)/);
  assert.match(source, /POST_TRIP_STATUSES = new Set\(\['confirmed', 'prep_sent', 'ready_for_departure', 'completed'\]\)/);
  assert.match(source, /readBookings\(\['awaiting_payment','confirmed','prep_sent','ready_for_departure','completed'\]\)/);
  assert.match(source, /POST_TRIP_STATUSES\.has\(booking\.status\)/);
  assert.doesNotMatch(source, /booking\.status === 'completed' \? selectPostTripCandidate/);
  assert.match(source, /fetchAllPages/);
});

test('a recorded legacy post-trip follow-up suppresses the new referral candidate before dry-run output', async () => {
  const source = await readFile(new URL('../app/api/cron/drip-emails/route.ts', import.meta.url), 'utf8');
  assert.match(source, /\.in\('template_key',\[\.\.\.LIFECYCLE_KEYS, 'post_trip_followup'\]\)/);
  assert.match(source, /event\.template_key === 'post_trip_followup' \? 'post_trip_referral' : event\.template_key/);
});

test('the automatic post-trip migration broadens only post-trip eligible statuses and preserves pre-trip eligibility', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261002010000_automatic_post_trip_eligibility.sql', import.meta.url), 'utf8');
  assert.match(sql, /p_template_key<>'post_trip_referral' and b\.status not in \('awaiting_payment','confirmed','prep_sent','ready_for_departure'\)/);
  assert.match(sql, /p_template_key='post_trip_referral' and b\.status not in \('confirmed','prep_sent','ready_for_departure','completed'\)/);
  assert.match(sql, /b\.status='cancelled'/);
  assert.match(sql, /select \* into control from public\.post_trip_sender_control where singleton=true for update/);
  assert.match(sql, /control\.active_owner is distinct from 'public'/);
  assert.match(sql, /when 'post_trip_referral' then 'post_trip_followup'/);
  assert.doesNotMatch(sql, /\b(update|delete|insert into) public\.bookings\b(?![^;]*lifecycle_email_token)/i);
  assert.match(sql, /revoke all on function public\.claim_lifecycle_email_dispatch[^;]+from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.claim_lifecycle_email_dispatch[^;]+to service_role;/);
});

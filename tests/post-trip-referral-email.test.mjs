import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { daysSinceTourEnd, selectPostTripCandidate, POST_TRIP_TEMPLATE } from '../lib/post-trip-email.mjs';

const dates = [
  { date: 'September 14 – 22, 2026', startDate: '2026-09-14', endDate: '2026-09-22' },
  { date: 'Private group date on request', requiresConfirmation: true },
];
const pick = (days, overrides = {}) => selectPostTripCandidate({ enabled: true, verifiedStripe: true, daysSinceEnd: days, sentTemplates: new Set(), ...overrides });

test('days since the end come from the departure list, not the label text', () => {
  assert.equal(daysSinceTourEnd('September 14 – 22, 2026', new Date('2026-09-25T20:00:00Z'), dates), 3);
  assert.equal(daysSinceTourEnd('Private group date on request', new Date('2026-09-25T00:00:00Z'), dates), null);
  assert.equal(daysSinceTourEnd('September 14 – 22 2026', new Date('2026-09-25T00:00:00Z'), dates), null);
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

test('nothing is selected until the flag is on, because the database must accept the template first', () => {
  assert.equal(pick(5, { enabled: false }), null);
});

test('the email states the agreed $100 each way and how to claim it', async () => {
  const source = await readFile(new URL('../lib/email.ts', import.meta.url), 'utf8');
  assert.match(source, /export const REFERRAL_REWARD_USD = 100;/);
  assert.match(source, /pay \$\{reward\} less on the in-person portion to the host family/);
  assert.match(source, /we send \$\{reward\} back to you once their booking is confirmed/);
  assert.match(source, /write your name in the notes when they book/);
});

test('the daily job keeps finished trips out of the capped upcoming query and behind the flag', async () => {
  const source = await readFile(new URL('../app/api/cron/drip-emails/route.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.POST_TRIP_EMAIL_ENABLED === 'true'/);
  assert.match(source, /\.in\('status',\['awaiting_payment','confirmed','prep_sent','ready_for_departure'\]\)/);
  assert.match(source, /if \(postTripEnabled\) \{[\s\S]*\.eq\('status','completed'\)/);
});

test('the migration only adds the post-trip key and leaves pre-trip eligibility untouched', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261001000000_post_trip_referral_email.sql', import.meta.url), 'utf8');
  assert.match(sql, /'final_checklist','post_trip_referral'\)\)/);
  assert.match(sql, /p_template_key<>'post_trip_referral' and b\.status not in \('awaiting_payment','confirmed','prep_sent','ready_for_departure'\)/);
  assert.match(sql, /p_template_key='post_trip_referral' and b\.status not in \('confirmed','prep_sent','ready_for_departure','completed'\)/);
  assert.match(sql, /revoke all on function public\.claim_lifecycle_email_dispatch[^;]+from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.claim_lifecycle_email_dispatch[^;]+to service_role;/);
  assert.doesNotMatch(sql, /\b(update|delete|insert into) public\.bookings\b(?![^;]*lifecycle_email_token)/i);
});

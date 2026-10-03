import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { GENDERS, normalizeBookingTravellers } from '../lib/booking-travellers.mjs';
import { normalizePublicBookingPayload } from '../lib/public-booking.mjs';

const RIDING_LEVELS = [
  'Beginner — little to none',
  'Intermediate — comfortable riding',
  'Advanced — experienced rider',
];

const validTraveller = (overrides = {}) => ({
  first_name: '  Ada ',
  last_name: ' Lovelace  ',
  email: ' ADA@EXAMPLE.COM ',
  phone: ' +44 20 1234 ',
  nationality: ' British ',
  gender: ' Female ',
  date_of_birth: '1990-12-10',
  riding_experience: RIDING_LEVELS[0],
  dietary_notes: ' Vegetarian ',
  ...overrides,
});

const validPayload = (overrides = {}) => ({
  submission_key: '123e4567-e89b-42d3-a456-426614174000',
  guest_count: '1',
  tour_date: 'September 15–23, 2026',
  emergency_contact: 'Grace +44 20 5555',
  how_heard: 'Friend',
  notes: 'Window seat if possible',
  signature: 'Ada Lovelace',
  waiver_agreed: 'on',
  travellers: [validTraveller()],
  attribution: { source: 'google', landing_url: 'https://www.8lakestours.com/' },
  ...overrides,
});

test('normalizes an exact manifest and derives the lead at position one', () => {
  const result = normalizeBookingTravellers(2, [
    validTraveller(),
    validTraveller({ first_name: 'Grace', last_name: 'Hopper', email: '', phone: '', dietary_notes: '' }),
  ], { today: '2026-09-10' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.travellers.map(({ position, is_lead, first_name, email }) => ({ position, is_lead, first_name, email })), [
    { position: 1, is_lead: true, first_name: 'Ada', email: 'ada@example.com' },
    { position: 2, is_lead: false, first_name: 'Grace', email: null },
  ]);
});

test('requires gender for every traveller and trims it', () => {
  const result = normalizeBookingTravellers(1, [validTraveller()], { today: '2026-09-10' });
  assert.equal(result.ok, true);
  assert.equal(result.travellers[0].gender, 'Female');

  const missing = normalizeBookingTravellers(2, [
    validTraveller(),
    validTraveller({ first_name: 'Grace', email: '', gender: '   ' }),
  ], { today: '2026-09-10' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Traveller 2 requires[^.]*gender/);
});

test('rejects invalid group sizes and unknown manifest cardinality', () => {
  for (const count of [0, 9, 1.5, '2 people', null]) {
    assert.equal(normalizeBookingTravellers(count, [validTraveller()], { today: '2026-09-10' }).ok, false);
  }
  assert.match(normalizeBookingTravellers(2, [validTraveller()], { today: '2026-09-10' }).error, /exactly 2 travellers/i);
});

test('rejects malformed, future, and unreasonably old dates of birth', () => {
  for (const date_of_birth of ['10/12/1990', '2026-02-30', '2026-09-11', '1899-12-31']) {
    const result = normalizeBookingTravellers(1, [validTraveller({ date_of_birth })], { today: '2026-09-10' });
    assert.equal(result.ok, false, `${date_of_birth} should be rejected`);
    assert.match(result.error, /date of birth/i);
  }
  assert.equal(normalizeBookingTravellers(1, [validTraveller({ date_of_birth: '2026-09-10' })], { today: '2026-09-10' }).ok, true);
});

test('whitelists riding levels', () => {
  for (const riding_experience of RIDING_LEVELS) {
    assert.equal(normalizeBookingTravellers(1, [validTraveller({ riding_experience })], { today: '2026-09-10' }).ok, true);
  }
  assert.match(normalizeBookingTravellers(1, [validTraveller({ riding_experience: 'expert-ish' })], { today: '2026-09-10' }).error, /riding level/i);
});

test('bounds every traveller field', () => {
  const limits = {
    first_name: 100,
    last_name: 100,
    email: 254,
    phone: 40,
    nationality: 80,
    gender: 40,
    dietary_notes: 1000,
  };
  for (const [field, limit] of Object.entries(limits)) {
    const value = field === 'email' ? `${'a'.repeat(limit - 11)}@example.com` : 'x'.repeat(limit + 1);
    const result = normalizeBookingTravellers(1, [validTraveller({ [field]: value })], { today: '2026-09-10' });
    assert.equal(result.ok, false, `${field} should be bounded`);
    assert.match(result.error, /too long/i);
  }
});

test('normalizes and bounds top-level public booking fields', () => {
  const result = normalizePublicBookingPayload(validPayload(), { today: '2026-09-10' });
  assert.equal(result.ok, true);
  assert.equal(result.value.submission_key, validPayload().submission_key);
  assert.equal(result.value.travellers[0].email, 'ada@example.com');

  for (const [field, limit] of Object.entries({ emergency_contact: 200, how_heard: 200, notes: 2000, signature: 150 })) {
    const invalid = normalizePublicBookingPayload(validPayload({ [field]: 'x'.repeat(limit + 1) }), { today: '2026-09-10' });
    assert.equal(invalid.ok, false, `${field} should be bounded`);
    assert.match(invalid.error, /too long/i);
  }
  assert.match(normalizePublicBookingPayload(validPayload({ submission_key: 'not-a-uuid' }), { today: '2026-09-10' }).error, /submission/i);
  assert.match(normalizePublicBookingPayload(validPayload({ attribution: { source: 'x'.repeat(201) } }), { today: '2026-09-10' }).error, /attribution/i);
});

test('migration defines atomic idempotent service-role booking RPC and schema invariants', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260910000000_booking_travellers.sql', import.meta.url), 'utf8');

  assert.match(sql, /add column if not exists submission_key uuid/i);
  assert.match(sql, /unique[^;]+submission_key/i);
  assert.match(sql, /is_lead boolean[^,]+check\s*\(is_lead\s*=\s*\(position\s*=\s*1\)\)/i);
  assert.match(sql, /details_complete boolean generated always as/i);
  assert.match(sql, /create or replace function public\.create_public_booking/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /current_setting\('request\.jwt\.claim\.role'/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /lower\(c\.email\)\s*=\s*lower\(/i);
  assert.match(sql, /jsonb_array_length\(p_travellers\)\s*<>\s*p_guest_count/i);
  assert.match(sql, /with ordinality/i);
  assert.match(sql, /insert into public\.booking_travellers/i);
  assert.match(sql, /insert into public\.booking_events/i);
  assert.match(sql, /return query[\s\S]+created/i);
  assert.match(sql, /revoke all on function public\.create_public_booking/i);
  assert.match(sql, /grant execute on function public\.create_public_booking[^;]+to service_role/i);
});

test('migration defines HMAC-key-only database rate limiting with bounded cleanup', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260910000000_booking_travellers.sql', import.meta.url), 'utf8');

  assert.match(sql, /create table if not exists public\.public_booking_rate_limits/i);
  assert.doesNotMatch(sql, /\bip_address\b|\bemail_address\b/i);
  assert.match(sql, /key_hash text not null/i);
  assert.match(sql, /create or replace function public\.consume_public_booking_rate_limits/i);
  assert.match(sql, /p_ip_key_hash text[\s\S]+p_email_key_hash text/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /limit\s+1000/i);
  assert.match(sql, /grant execute on function public\.consume_public_booking_rate_limits[^;]+to service_role/i);
});

test('route bounds body, consumes both hashed rate keys, and uses only the atomic booking RPC', async () => {
  const api = await readFile(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8');

  assert.match(api, /MAX_REQUEST_BYTES/);
  assert.match(api, /content-length/i);
  assert.match(api, /createHmac/);
  assert.match(api, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(api, /consume_public_booking_rate_limits/);
  assert.match(api, /ip_key_hash/);
  assert.match(api, /email_key_hash/);
  assert.match(api, /\.rpc\('create_public_booking'/);
  assert.doesNotMatch(api, /\.from\('customers'\)|\.from\('bookings'\)|\.from\('booking_travellers'\)/);
  assert.doesNotMatch(api, /insertBookingTravellersOrRollback/);
});

test('route treats durable persistence as success and claims email sends idempotently', async () => {
  const api = await readFile(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8');

  assert.match(api, /claim_public_booking_email/);
  assert.match(api, /finalize_public_booking_email/);
  assert.match(api, /idempotencyKey:/);
  assert.match(api, /catch\s*\(/);
  assert.match(api, /NextResponse\.json\(\{ ok: true, reference/);
  assert.ok(api.lastIndexOf('NextResponse.json({ ok: true, reference') > api.lastIndexOf('sendEmail({'));
});

test('customer and internal emails contain submitted names but no birth dates', async () => {
  const email = await readFile(new URL('../lib/email.ts', import.meta.url), 'utf8');
  assert.match(email, /bookingCustomerEmail\(input:[\s\S]+travellerNames\??: string/);
  assert.match(email, /Submitted traveller names/);
  assert.doesNotMatch(email, /dateOfBirth|date_of_birth/);
});

test('public form uses a stable client UUID, legal-name labels, semantic companion groups, and live count announcements', async () => {
  const client = await readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8');

  assert.match(client, /crypto\.randomUUID\(\)/);
  assert.match(client, /submission_key:\s*submissionKeyRef\.current/);
  assert.match(client, /Passport\/Legal First Name/);
  assert.match(client, /Passport\/Legal Last Name/);
  assert.match(client, /<fieldset[^>]*className="[^"]*companion-fields/);
  assert.match(client, /<legend[^>]*>Traveller \{travellerNumber\}/);
  assert.match(client, /aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(client, /traveller sections? ready/i);
  assert.match(client, /maxLength=/);
});

test('obsolete direct-insert rollback helper is removed', async () => {
  await assert.rejects(readFile(new URL('../lib/booking-traveller-persistence.mjs', import.meta.url), 'utf8'), /ENOENT/);
});

test('privacy policy discloses traveller manifest details including dates of birth', async () => {
  const privacy = await readFile(new URL('../app/privacy/page.tsx', import.meta.url), 'utf8');
  assert.match(privacy, /each traveller/i);
  assert.match(privacy, /date of birth/i);
  assert.match(privacy, /permission to provide (?:their|these) details/i);
  assert.match(privacy, /lead booker[^.]+waiver/i);
});

test('gender must be one of the offered options', () => {
  const invalid = normalizeBookingTravellers(1, [validTraveller({ gender: 'unspecified' })]);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Traveller 1 gender is invalid/);
  for (const gender of GENDERS) {
    const result = normalizeBookingTravellers(1, [validTraveller({ gender })]);
    assert.equal(result.ok, true);
    assert.equal(result.travellers[0].gender, gender);
  }
});

test('a signature must read as a name and the waiver must be explicitly agreed', () => {
  // Two keystrokes used to pass, and nothing recorded that the waiver was read.
  for (const signature of ['ab', 'Ada', 'A L', 'x'.repeat(3)]) {
    const result = normalizePublicBookingPayload(validPayload({ signature }));
    assert.equal(result.ok, false, `${signature} must not pass as a signature`);
    assert.match(result.error, /full legal name/);
  }
  assert.equal(normalizePublicBookingPayload(validPayload({ signature: 'Ada Lovelace' })).ok, true);

  for (const waiver of ['', undefined, 'yes', 'true']) {
    const result = normalizePublicBookingPayload(validPayload({ waiver_agreed: waiver }));
    assert.equal(result.ok, false, `waiver_agreed=${waiver} must not pass`);
    assert.match(result.error, /liability waiver/);
  }
});

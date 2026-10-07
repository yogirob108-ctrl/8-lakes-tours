import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ageOn, validateRiderWaiver, WAIVER_SECTIONS, WAIVER_VERSION, waiverPlainText } from '../lib/waiver.mjs';
import { normalizePublicBookingPayload } from '../lib/public-booking.mjs';

const today = '2026-10-06';
const adult = {
  reference: '8l-abc123',
  rider_name: 'Jane Rider',
  rider_email: 'jane@example.com',
  date_of_birth: '1990-05-01',
  signature: 'Jane Rider',
  agreed: 'on',
};

test('age counts whole years and respects the birthday', () => {
  assert.equal(ageOn('2008-10-06', today), 18);
  assert.equal(ageOn('2008-10-07', today), 17);
  assert.equal(ageOn('not-a-date', today), null);
});

test('an adult rider signs for themselves with a matching name', () => {
  const result = validateRiderWaiver(adult, { today });
  assert.equal(result.ok, true);
  assert.equal(result.value.reference, '8L-ABC123');
  assert.equal(result.value.isMinor, false);
  assert.equal(result.value.waiverVersion, WAIVER_VERSION);
  assert.equal(validateRiderWaiver({ ...adult, signature: 'Someone Else' }, { today }).ok, false);
  assert.equal(validateRiderWaiver({ ...adult, agreed: '' }, { today }).ok, false);
  assert.equal(validateRiderWaiver({ ...adult, reference: 'ABC' }, { today }).ok, false);
});

test('a rider aged 16 or 17 needs a parent or guardian to sign', () => {
  const minor = { ...adult, date_of_birth: '2009-01-01', signature: 'Jane Rider' };
  assert.equal(validateRiderWaiver(minor, { today }).ok, false);
  const signed = validateRiderWaiver({ ...minor, guardian_name: 'Mary Rider', guardian_relationship: 'Mother', signature: 'Mary Rider' }, { today });
  assert.equal(signed.ok, true);
  assert.equal(signed.value.isMinor, true);
  assert.equal(signed.value.guardianName, 'Mary Rider');
});

test('riders under 16 cannot join the trek', () => {
  const result = validateRiderWaiver({ ...adult, date_of_birth: '2012-01-01', guardian_name: 'Mary Rider', guardian_relationship: 'Mother', signature: 'Mary Rider' }, { today });
  assert.equal(result.ok, false);
});

test('the waiver covers medical consent, conduct, helmets and minors', () => {
  const titles = WAIVER_SECTIONS.map(section => section.title).join(' | ');
  for (const topic of ['Emergency Medical Treatment', 'Safety Instructions and Conduct', 'Helmets', 'Under 18']) assert.match(titles, new RegExp(topic));
  assert.match(waiverPlainText(), /binding upon myself/);
});

test('the booking form and the rider page render the same shared waiver text', async () => {
  const [home, page] = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/waiver/page.tsx', import.meta.url), 'utf8'),
  ]);
  for (const source of [home, page]) assert.match(source, /WAIVER_SECTIONS\.map/);
  assert.doesNotMatch(home, /\['1\. Nature of Activity'/);
});

test('the lead booker must be 18 or older', () => {
  const traveller = { first_name: 'Teen', last_name: 'Lead', email: 'teen@example.com', nationality: 'US', gender: 'Female', date_of_birth: '2009-01-01', riding_experience: 'Beginner — little to none' };
  const payload = { submission_key: '123e4567-e89b-42d3-a456-426614174000', guest_count: 1, travellers: [traveller], signature: 'Teen Lead', waiver_agreed: 'on' };
  const result = normalizePublicBookingPayload(payload, { today });
  assert.equal(result.ok, false);
  assert.match(result.error, /18 or older/);
});

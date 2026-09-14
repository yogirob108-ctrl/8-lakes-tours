import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftCredential, draftFingerprint, sanitizeDraftPayload, verifyDraftCredential } from '../lib/checkout-draft.mjs';

test('anonymous draft credential is opaque, scoped, and verifies only the same draft', () => {
  const credential = createDraftCredential('draft-1', 'secret');
  assert.match(credential, /^v1\.[0-9a-f]{64}$/);
  assert.equal(verifyDraftCredential('draft-1', credential, 'secret'), true);
  assert.equal(verifyDraftCredential('draft-2', credential, 'secret'), false);
  assert.equal(verifyDraftCredential('draft-1', 'v1.bad', 'secret'), false);
});

test('draft payload keeps only bounded intake fields and excludes payment data', () => {
  const draft = sanitizeDraftPayload({
    first_name: ' Ada ', last_name: ' Rider ', email: 'ADA@Example.COM ', phone: '+31 6 123',
    tour_date: 'Scheduled', guest_count: '2', notes: 'Vegetarian', card_number: '4242424242424242',
    travellers: [{ first_name: ' Ada ', last_name: ' Rider ', date_of_birth: '1990-01-02' }],
  });
  assert.deepEqual(draft, { first_name: 'Ada', last_name: 'Rider', email: 'ada@example.com', phone: '+31 6 123', tour_date: 'Scheduled', guest_count: 2, notes: 'Vegetarian', travellers: [{ first_name: 'Ada', last_name: 'Rider', date_of_birth: '1990-01-02' }] });
  assert.equal(JSON.stringify(draft).includes('4242'), false);
  assert.equal(draftFingerprint(draft), draftFingerprint({...draft}));
});

test('draft save contract requires contact before server persistence and uses no booking reference', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../app/api/checkout-draft/route.ts', import.meta.url), 'utf8'));
  assert.match(source, /sanitizeDraftPayload/);
  assert.match(source, /save_public_checkout_draft/);
  assert.match(source, /Cache-Control': 'no-store/);
  assert.doesNotMatch(source, /create_public_booking/);
});

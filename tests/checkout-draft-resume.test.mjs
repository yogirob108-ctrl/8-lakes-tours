import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../app/api/checkout-draft/route.ts', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8');

test('stored draft can be read only by a credential submitted in a no-store POST body', () => {
  assert.match(route, /input\.action === 'load'/);
  assert.match(route, /verifyDraftCredential\(draftId, credential, secret\)/);
  assert.match(route, /public_checkout_drafts/);
  assert.match(route, /credential_hash/);
  assert.doesNotMatch(route, /export async function GET/);
});

test('form restores a verified stored draft before a guest submits checkout', () => {
  assert.match(ui, /action: 'load'/);
  assert.match(ui, /restoreCheckoutDraft/);
  assert.match(ui, /draftOwnershipRef\.current/);
  assert.match(ui, /setEmail\(String\(draft\.email/);
  assert.match(ui, /form\.elements\.namedItem/);
});

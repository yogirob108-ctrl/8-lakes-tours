import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../lib/email.ts', import.meta.url), 'utf8');

test('preparation email says camping gear is provided and guests may bring their own', () => {
  assert.equal(source.match(/tents, sleeping mats, warm sleeping bags, and camp cooking kit are provided for the trek/g)?.length, 2);
  assert.equal(source.match(/you are welcome to bring it/g)?.length, 2);
});

test('emails are signed and voiced as Robert throughout', () => {
  assert.doesNotMatch(source, /Rob Zaher|Robert will coordinate/);
});

test('newsletter welcome only promises the price hold while it runs, and offers the call', () => {
  assert.match(source, /const priceHold = isPriceHoldActive\(now\)/);
  assert.match(source, /free 15-minute call by phone, WhatsApp, or Zoom/);
});

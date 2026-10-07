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

test('newsletter welcome only promises the price hold while it runs, and offers a question-or-call conversation', () => {
  assert.match(source, /const priceHold = isPriceHoldActive\(now\)/);
  assert.match(source, /Want to ask a question or talk it through\? Reply to this email and we can arrange a call by phone, WhatsApp, or Zoom/);
  assert.doesNotMatch(source, new RegExp(['free', '15-minute', 'call'].join(' '), 'i'));
});

test('WhatsApp goes to booked guests only, never newsletter signups', () => {
  // Six lifecycle emails plus the signed-waiver copy, all to booked guests.
  assert.equal(source.match(/\$\{WHATSAPP_LINE_TEXT\}/g)?.length, 7);
  assert.equal(source.match(/p\(WHATSAPP_LINE_HTML\)/g)?.length, 7);
  const welcome = source.slice(source.indexOf('export function leadCustomerEmail('));
  assert.doesNotMatch(welcome.slice(0, welcome.indexOf('\n}\n')), /WHATSAPP/);
  assert.match(source, /https:\/\/wa\.me\/18582317131/);
});

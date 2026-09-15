// Quiet signature block: every customer-facing email carries the muted four-line
// block under the signoff; internal operator notifications stay unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { recoveryEmail } from '../lib/abandoned-checkout.mjs';
import { draftRecoveryEmail } from '../lib/pre-submit-draft-recovery.mjs';

const nodeRequire = createRequire(import.meta.url);
const REPO = '/Users/kokos/Projects/8-lakes-public-lifecycle';
const SIGNATURE_HTML = 'www.8lakestours.com<br>info@8lakestours.com';
const SIGNATURE_TEXT = 'www.8lakestours.com\ninfo@8lakestours.com';

function loadEmailModule(repoPath) {
  const source = readFileSync(`${repoPath}/lib/email.ts`, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replace(/require\("@\/lib\/final-checklist-content\.mjs"\)/g, `require("${repoPath}/lib/final-checklist-content.mjs")`)
    .replace(/require\("\.\/tour-booking\.mjs"\)/g, `require("${repoPath}/lib/tour-booking.mjs")`)
    .replace(/require\("resend"\)/g, '({ Resend: function(){} })');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', code)(m, m.exports, (x) => nodeRequire(x));
  return m.exports;
}

const email = loadEmailModule(REPO);

const customerBuilders = [
  ['bookingCustomerEmail', () => email.bookingCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' })],
  ['bookingCustomerEmail (group invoice)', () => email.bookingCustomerEmail({ reference: '8L-TEST02', firstName: 'Sam', tourDate: '25 September 2026', guestCount: 3, manualPaymentReason: 'group_invoice' })],
  ['bookingCustomerEmail (availability)', () => email.bookingCustomerEmail({ reference: '8L-TEST03', firstName: 'Jordan', tourDate: '1 October 2026', guestCount: 2, requiresManualPaymentLink: true })],
  ['paymentConfirmedCustomerEmail', () => email.paymentConfirmedCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026', amountUsd: 999 })],
  ['preparationCustomerEmail', () => email.preparationCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' })],
  ['insuranceReminderCustomerEmail', () => email.insuranceReminderCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' })],
  ['arrivalCoordinationCustomerEmail', () => email.arrivalCoordinationCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' })],
  ['finalChecklistCustomerEmail', () => email.finalChecklistCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' })],
  ['leadCustomerEmail', () => email.leadCustomerEmail({ name: 'Alex' })],
];

test('every customer-facing email carries the quiet four-line signature block', () => {
  for (const [name, build] of customerBuilders) {
    const mail = build();
    assert.ok(mail.html.includes(SIGNATURE_HTML), `${name}: html missing signature block`);
    assert.ok(mail.html.includes('font-size:13px;line-height:1.6;color:#767676'), `${name}: signature block not muted small text`);
    assert.ok(mail.text.includes(SIGNATURE_TEXT), `${name}: text missing signature block`);
    assert.ok(mail.html.includes('<p style="margin:24px 0 0">Rob Zaher<br>8 Lakes Tours</p>'), `${name}: signoff damaged`);
  }
});

test('internal operator notifications do not gain the customer signature block', () => {
  const internal = [
    ['bookingInternalEmail', () => email.bookingInternalEmail({ reference: '8L-TEST01', firstName: 'Alex', lastName: 'Tester', email: 'alex@example.invalid', phone: '', tourDate: '23 September 2026', ridingExperience: 'Beginner', notes: 'note' })],
    ['paymentReceivedInternalEmail', () => email.paymentReceivedInternalEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026', amountUsd: 999, customerName: 'Alex Tester', customerEmail: 'alex@example.invalid', stripeReference: 'ch_fixture' })],
    ['leadInternalEmail', () => email.leadInternalEmail({ name: 'Alex', email: 'alex@example.invalid', source: 'test', interest: 'test' })],
  ];
  for (const [name, build] of internal) {
    const mail = build();
    assert.ok(!mail.html.includes(SIGNATURE_HTML), `${name}: html must not carry the customer signature block`);
    assert.ok(!mail.text.includes(SIGNATURE_TEXT), `${name}: text must not carry the customer signature block`);
  }
});

test('abandoned checkout and draft recovery emails carry the signature block', () => {
  const recovery = recoveryEmail({ email: 'alex@example.invalid', first_name: 'Alex', public_reference: '8L-TEST01' }, 'https://example.invalid/pay?token=private');
  const draft = draftRecoveryEmail({ email: 'alex@example.invalid', first_name: 'Alex', draft_id: 'fixture' }, 'https://example.invalid/pay?token=private');
  for (const [name, mail] of [['recoveryEmail', recovery], ['draftRecoveryEmail', draft]]) {
    assert.ok(mail.html.includes(SIGNATURE_HTML), `${name}: html missing signature block`);
    assert.ok(mail.html.includes('color:#767676'), `${name}: signature block not muted`);
    assert.ok(mail.text.includes(SIGNATURE_TEXT), `${name}: text missing signature block`);
  }
});

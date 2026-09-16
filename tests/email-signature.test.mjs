// Quiet signature block: every customer-facing email carries the muted four-line
// block under the signoff; internal operator notifications stay unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { recoveryEmail } from '../lib/abandoned-checkout.mjs';
import { draftRecoveryEmail } from '../lib/pre-submit-draft-recovery.mjs';

const nodeRequire = createRequire(import.meta.url);
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SIGNATURE_HTML = 'www.8lakestours.com<br>info@8lakestours.com';
const SIGNATURE_TEXT = 'www.8lakestours.com\ninfo@8lakestours.com';
const RULE_HTML = '<div style="border-top:1px dashed #cccccc;margin:0 0 16px"></div>';
const RULE_TEXT = '\n--------------------------------\n';

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

test('long customer emails carry subtle dashed section rules between natural sections', () => {
  const expectations = [
    // [builder, minimum rules, must sit before the booking-facts block]
    ['bookingCustomerEmail (default)', () => email.bookingCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' }), 3],
    ['bookingCustomerEmail (group invoice)', () => email.bookingCustomerEmail({ reference: '8L-TEST02', firstName: 'Sam', tourDate: '25 September 2026', guestCount: 3, manualPaymentReason: 'group_invoice' }), 3],
    ['bookingCustomerEmail (availability)', () => email.bookingCustomerEmail({ reference: '8L-TEST03', firstName: 'Jordan', tourDate: '1 October 2026', guestCount: 2, requiresManualPaymentLink: true }), 3],
    ['preparationCustomerEmail', () => email.preparationCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' }), 2],
    ['paymentConfirmedCustomerEmail', () => email.paymentConfirmedCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026', amountUsd: 999 }), 1],
    ['insuranceReminderCustomerEmail', () => email.insuranceReminderCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' }), 1],
    ['arrivalCoordinationCustomerEmail', () => email.arrivalCoordinationCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' }), 1],
    ['finalChecklistCustomerEmail', () => email.finalChecklistCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' }), 1],
  ];
  for (const [name, build, minRules] of expectations) {
    const mail = build();
    const htmlRules = mail.html.split(RULE_HTML).length - 1;
    const textRules = mail.text.split(RULE_TEXT).length - 1;
    assert.ok(htmlRules >= minRules, `${name}: expected >= ${minRules} html section rules, found ${htmlRules}`);
    assert.ok(textRules >= minRules, `${name}: expected >= ${minRules} text dash rules, found ${textRules}`);
    assert.equal(htmlRules, textRules, `${name}: html and text rules must stay in lockstep`);
    // Rule is a thin muted dashed line, not a heavy divider, and matches the palette.
    assert.match(RULE_HTML, /border-top:1px dashed #cccccc/);
    // Facts survive the rules: the booking reference must still appear in text and html.
    const reference = name.includes('group invoice') ? '8L-TEST02' : name.includes('availability') ? '8L-TEST03' : '8L-TEST01';
    assert.ok(mail.text.includes(`Booking reference: ${reference}`), `${name}: text booking facts damaged`);
    assert.ok(mail.html.includes(reference), `${name}: html booking facts damaged`);
  }
  // The first rule in the booking email separates greeting/intro from booking facts.
  const booking = email.bookingCustomerEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026' });
  assert.ok(booking.text.indexOf(RULE_TEXT) < booking.text.indexOf('Booking reference:'), 'booking: first rule must precede booking facts');
  assert.ok(booking.text.indexOf(RULE_TEXT) > booking.text.indexOf('Thanks for booking'), 'booking: first rule must follow the greeting/intro');
});

test('short customer emails stay clean or carry at most one rule', () => {
  const newsletter = email.leadCustomerEmail({ name: 'Alex' });
  assert.ok(!newsletter.html.includes(RULE_HTML), 'newsletter welcome: short email should carry no section rule');
  assert.ok(!newsletter.text.includes(RULE_TEXT), 'newsletter welcome: short email should carry no dash rule');

  const recovery = recoveryEmail({ email: 'alex@example.invalid', first_name: 'Alex', public_reference: '8L-TEST01' }, 'https://example.invalid/pay?token=private');
  const draft = draftRecoveryEmail({ email: 'alex@example.invalid', first_name: 'Alex', draft_id: 'fixture' }, 'https://example.invalid/pay?token=private');
  for (const [name, mail] of [['recoveryEmail', recovery], ['draftRecoveryEmail', draft]]) {
    const htmlRules = mail.html.split(RULE_HTML).length - 1;
    const textRules = mail.text.split(RULE_TEXT).length - 1;
    assert.ok(htmlRules <= 1, `${name}: at most one section rule, found ${htmlRules}`);
    assert.ok(textRules <= 1, `${name}: at most one dash rule, found ${textRules}`);
    assert.equal(htmlRules, textRules, `${name}: html and text rules must stay in lockstep`);
    assert.ok(mail.text.includes('https://example.invalid/pay?token=private'), `${name}: private link damaged`);
  }
});

test('internal operator notifications gain no section rules', () => {
  const internal = [
    ['bookingInternalEmail', () => email.bookingInternalEmail({ reference: '8L-TEST01', firstName: 'Alex', lastName: 'Tester', email: 'alex@example.invalid', phone: '', tourDate: '23 September 2026', ridingExperience: 'Beginner', notes: 'note' })],
    ['paymentReceivedInternalEmail', () => email.paymentReceivedInternalEmail({ reference: '8L-TEST01', firstName: 'Alex', tourDate: '23 September 2026', amountUsd: 999, customerName: 'Alex Tester', customerEmail: 'alex@example.invalid', stripeReference: 'ch_fixture' })],
    ['leadInternalEmail', () => email.leadInternalEmail({ name: 'Alex', email: 'alex@example.invalid', source: 'test', interest: 'test' })],
  ];
  for (const [name, build] of internal) {
    const mail = build();
    assert.ok(!mail.html.includes(RULE_HTML), `${name}: internal html must not carry section rules`);
    assert.ok(!mail.text.includes(RULE_TEXT), `${name}: internal text must not carry dash rules`);
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

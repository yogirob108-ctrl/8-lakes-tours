import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/email.ts', import.meta.url), 'utf8');

function loadEmail({ apiKey, providerResult }) {
  class Resend {
    constructor() {
      this.emails = { send: async () => providerResult };
    }
  }
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'process', code)(module, module.exports, (name) => {
    if (name === 'resend') return { Resend };
    if (name === './tour-booking.mjs') return { GROUP_INVOICE: 'group_invoice' };
    if (name === './price-hold.mjs') return { isPriceHoldActive: () => false, PRICE_HOLD_DEADLINE_LABEL: '' };
    throw new Error(`unexpected import: ${name}`);
  }, { env: apiKey ? { RESEND_API_KEY: apiKey } : {} });
  return module.exports;
}

const message = { to: 'rider@example.invalid', subject: 'fixture', html: '<p>fixture</p>' };

test('every provider-returned error remains an unknown delivery outcome', async () => {
  for (const statusCode of [400, 408, 409, 500, null]) {
    const email = loadEmail({
      apiKey: 'test-key',
      providerResult: { data: null, error: { message: `provider ${statusCode}`, statusCode } },
    });
    const result = await email.sendEmail(message);
    assert.equal(result.sent, false, `status ${statusCode}`);
    assert.equal(result.statusCode, statusCode, `status ${statusCode}`);
    assert.equal(result.definiteFailure, false, `status ${statusCode} must be reconciled`);
  }
});

test('a missing API key remains a definite local pre-provider failure', async () => {
  const email = loadEmail({ apiKey: '', providerResult: { data: { id: 'must-not-send' }, error: null } });
  const result = await email.sendEmail(message);
  assert.deepEqual(result, {
    sent: false,
    error: 'RESEND_API_KEY is not configured',
    definiteFailure: true,
  });
});

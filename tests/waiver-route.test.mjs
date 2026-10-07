import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import * as waiver from '../lib/waiver.mjs';

const payload = {
  reference: '8L-TEST01', rider_name: 'Jane Rider', rider_email: 'jane@example.invalid',
  date_of_birth: '1990-02-03', signature: 'Jane Rider', agreed: 'on',
};

function harness({
  recordError,
  sendResult = { sent: true, id: 'provider-id' },
  completeError = false,
  claimedInternalRecipient = 'frozen-ops-a@example.invalid, frozen-ops-b@example.invalid',
  claimedRiderRecipient = 'frozen-rider@example.invalid',
} = {}) {
  const calls = [];
  const sentEmails = [];
  const snapshot = {
    rider_name_snapshot: 'Jane Rider', rider_email_snapshot: 'jane@example.invalid', guardian_name_snapshot: null,
    guardian_relationship_snapshot: null, signature_snapshot: 'Jane Rider', signed_waiver_text: waiver.waiverPlainText(),
    server_signed_at: '2026-10-07T10:00:00.000Z', trusted_ip_address: null, user_agent: null, is_minor: false,
  };
  let dispatches = 0;
  const db = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'record_rider_waiver') return recordError ? { error: recordError } : { data: { waiver_id: 'waiver-1', match_status: 'matched' } };
      if (name === 'claim_rider_waiver_email_dispatch') {
        dispatches += 1;
        const recipient_email = args.p_destination === 'internal' ? claimedInternalRecipient : claimedRiderRecipient;
        return { data: { should_send: true, dispatch_id: `dispatch-${dispatches}`, recipient_email, idempotency_key: `key-${dispatches}` } };
      }
      if (name === 'mark_rider_waiver_email_provider_attempted') return { data: true };
      if (name === 'complete_rider_waiver_email_dispatch') return completeError ? { error: { message: 'finalize failed' } } : { data: true };
      throw new Error(`unexpected RPC ${name}`);
    },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: snapshot, error: null }) }) }) }),
  };
  const code = ts.transpileModule(readFileSync(new URL('../app/api/waiver/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Request, process: { env: {} }, require(name) {
    if (name === 'node:crypto') return crypto;
    if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
    if (name === '@/lib/email') return {
      getInternalEmailRecipients: () => ['ops@example.invalid'], riderWaiverCustomerEmail: () => ({ subject: 'customer', text: 'x', html: 'x' }),
      riderWaiverInternalEmail: () => ({ subject: 'internal', text: 'x', html: 'x' }),
      sendEmail: async (input) => { sentEmails.push(input); return sendResult; },
    };
    if (name === '@/lib/ops-config') return { isSupabaseAdminConfigured: true };
    if (name === '@/lib/supabase-admin') return { createSupabaseAdminClient: () => db };
    if (name === '@/lib/waiver.mjs') return waiver;
    throw new Error(name);
  } });
  return {
    calls,
    sentEmails,
    run: (body = payload) => exports.POST(new Request('https://example.invalid/api/waiver', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })),
  };
}

test('provider recipients come only from the claimed frozen dispatch', async () => {
  const h = harness();
  await h.run();
  assert.equal(h.sentEmails.length, 2);
  assert.deepEqual(Array.from(h.sentEmails[0].to), ['frozen-ops-a@example.invalid', 'frozen-ops-b@example.invalid']);
  assert.equal(h.sentEmails[1].to, 'frozen-rider@example.invalid');
  assert.ok(h.sentEmails.every((email) => email.to !== 'ops@example.invalid' && email.to !== 'jane@example.invalid'));
});

test('an absent claimed recipient stops before the provider-attempt marker', async () => {
  const h = harness({ claimedInternalRecipient: '   ' });
  await h.run();
  assert.equal(h.sentEmails.length, 1, 'the rider dispatch can still use its own valid claim');
  assert.equal(h.calls.filter((call) => call.name === 'mark_rider_waiver_email_provider_attempted').length, 1);
});

test('transport-like Resend result is reconciled, not retried as definite failure', async () => {
  const h = harness({ sendResult: { sent: false, error: 'network error', statusCode: null } });
  const response = await h.run();
  assert.equal(response.status, 200);
  const complete = h.calls.filter(call => call.name === 'complete_rider_waiver_email_dispatch');
  assert.equal(complete.length, 2);
  assert.deepEqual(complete.map(call => call.args.p_definite_failure), [false, false]);
});

test('dispatch finalization failure does not turn a stored waiver into an API failure', async () => {
  const h = harness({ completeError: true });
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
});

test('a missing booking uses the same generic public response while an outage remains an error', async () => {
  const missing = harness({ recordError: { code: 'P0002', message: 'booking not found for waiver reference' } });
  const outage = harness({ recordError: { code: '08006', message: 'connection failure' } });
  const missingResponse = await missing.run();
  assert.equal(missingResponse.status, 200);
  assert.equal(missingResponse.body.ok, true);
  assert.equal((await outage.run()).status, 502);
});

test('route ignores spoofed legal version and text fields and persists the canonical text hash', async () => {
  const h = harness();
  await h.run({ ...payload, waiver_version: 'forged', signed_waiver_text: 'forged legal text' });
  const recorded = h.calls.find(call => call.name === 'record_rider_waiver').args;
  assert.equal(recorded.p_waiver_version, waiver.WAIVER_VERSION);
  assert.equal(recorded.p_signed_waiver_text, waiver.waiverPlainText());
  assert.equal(recorded.p_signed_waiver_text_sha256, waiver.WAIVER_TEXT_SHA256);
});

test('submission identity binds canonical email and every immutable signed field', async () => {
  const keyFor = async body => {
    const h = harness();
    await h.run(body);
    return h.calls.find(call => call.name === 'record_rider_waiver').args.p_submission_key;
  };
  const canonical = await keyFor({ ...payload, rider_email: ' JANE@EXAMPLE.INVALID ' });
  assert.equal(canonical, await keyFor(payload), 'email case and outer whitespace are canonicalized');
  for (const changed of [
    { rider_email: 'other@example.invalid' },
    { date_of_birth: '1991-02-03' },
    { signature: 'Jane  Rider' },
    { rider_name: 'Jane Quinn Rider', signature: 'Jane Quinn Rider' },
  ]) {
    assert.notEqual(canonical, await keyFor({ ...payload, ...changed }), `changed immutable field must not reuse submission key: ${JSON.stringify(changed)}`);
  }
  const minor = { ...payload, date_of_birth: '2010-02-03', guardian_name: 'Guardian Rider', guardian_relationship: 'parent', signature: 'Guardian Rider' };
  const minorKey = await keyFor(minor);
  assert.notEqual(minorKey, await keyFor({ ...minor, guardian_name: 'Other Guardian', signature: 'Other Guardian' }));
  assert.notEqual(minorKey, await keyFor({ ...minor, guardian_relationship: 'legal guardian' }));
});

test('identity conflict is internally distinguishable but has the generic received response', async () => {
  const h = harness({ recordError: { code: 'P0003', message: 'waiver snapshot conflicts with an existing signature' } });
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
});

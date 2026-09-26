import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import * as normalizer from '../lib/public-booking.mjs';
import * as pricing from '../lib/group-pricing.mjs';
import { isValidBookingEmail } from '../lib/email-validation.mjs';

const validTraveller = (email = 'rider+summer@updates.example.co.uk') => ({
  first_name: 'Test', last_name: 'Rider', email, nationality: 'Testland', gender: 'Female',
  date_of_birth: '1990-01-01', riding_experience: 'Beginner — little to none',
});
const validPayload = (email) => ({
  submission_key: '123e4567-e89b-42d3-a456-426614174222', tour_date: 'scheduled', guest_count: 1,
  signature: 'Test Rider', waiver_agreed: 'on', travellers: [validTraveller(email)],
});

function invalidApiHarness(email) {
  const calls = [];
  const sent = [];
  const code = ts.transpileModule(readFileSync(new URL('../app/api/bookings/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, TextEncoder, Request, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'test-only' } },
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, ...init }) } };
      if (name === '@/lib/ops-config') return { isSupabaseAdminConfigured: true };
      if (name === '@/lib/supabase-admin') return { createSupabaseAdminClient: () => ({ rpc: async name => { calls.push(name); throw new Error(`unexpected ${name}`); } }) };
      if (name === '@/lib/public-booking.mjs') return normalizer;
      if (name === '@/lib/group-pricing.mjs') return pricing;
      if (name === '@/lib/booking-checkout') return { recoveryUrl: () => '/pay/private' };
      if (name === '@/lib/newsletter') return { subscribeToNewsletter: async () => { sent.push('newsletter'); } };
      if (name === '@/lib/newsletter-consent.mjs') return { hasExplicitNewsletterOptIn: () => false };
      if (name === '@/lib/tour-booking.mjs') return { isBookableTourDate: () => true, requiresManualPaymentLink: () => false, manualPaymentReason: () => null, normalizeTourDateSelection: value => String(value ?? '').trim() };
      if (name === '@/lib/email') return { bookingCustomerEmail: () => ({}), bookingInternalEmail: () => ({}), getInternalEmailRecipients: () => [], sendEmail: async () => { sent.push('email'); return { sent: true }; } };
      throw new Error(name);
    },
  });
  return {
    calls, sent,
    run: () => exports.POST(new Request('https://example.invalid/api/bookings', { method: 'POST', body: JSON.stringify(validPayload(email)) })),
  };
}

test('strict booking email validator accepts outer whitespace, plus tags, and subdomains only', () => {
  for (const value of [' rider+summer@updates.example.co.uk ', 'a.b-c@travel.example.tours']) {
    assert.equal(isValidBookingEmail(value), true, value);
  }
  for (const value of ['', 'name', 'name@domain', 'name@domain.', 'name @domain.tld', 'name@domain .tld', 'name@@domain.tld', '@domain.tld', 'name@.tld']) {
    assert.equal(isValidBookingEmail(value), false, value);
  }
});

test('server rejects malformed lead and optional companion emails before persistence or email side effects', async () => {
  for (const email of ['name@domain', 'name @domain.tld', 'name@@domain.tld']) {
    const h = invalidApiHarness(email);
    const response = await h.run();
    assert.equal(response.status, 400, email);
    assert.match(response.body.error, /email address is invalid/i);
    assert.deepEqual(h.calls, [], `${email} made no database or booking call`);
    assert.deepEqual(h.sent, [], `${email} sent no email`);
  }

  const companion = normalizer.normalizePublicBookingPayload({
    ...validPayload('lead@example.tld'), guest_count: 2,
    travellers: [validTraveller('lead@example.tld'), validTraveller('companion@domain')],
  });
  assert.equal(companion.ok, false);
  assert.match(companion.error, /Traveller 2 email address is invalid/i);
});

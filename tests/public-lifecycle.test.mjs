import test from 'node:test';
import assert from 'node:assert/strict';
import { getDryRun, selectPacedLifecycleCandidate, reconcileStripeSessions } from '../lib/public-lifecycle.mjs';

test('only explicit dry_run and dryRun query spellings enable a reconciliation dry run', () => {
  assert.equal(getDryRun(new URL('https://example.test/api?dry_run=1')), true);
  assert.equal(getDryRun(new URL('https://example.test/api?dryRun=1')), true);
  assert.equal(getDryRun(new URL('https://example.test/api?dryrun=1')), false);
  assert.equal(getDryRun(new URL('https://example.test/api?dry_run=true')), false);
});

test('Stripe reconciliation accepts only exact paid Checkout reference matches', () => {
  const rows = reconcileStripeSessions({
    bookings: [{ id: 'b1', reference: '8L-ABC123' }, { id: 'b2', reference: '8L-DEF456' }],
    sessions: [
      { id: 'cs_paid', client_reference_id: '8L-ABC123', payment_status: 'paid' },
      { id: 'cs_partial', client_reference_id: '8L-DEF456-extra', payment_status: 'paid' },
      { id: 'cs_open', client_reference_id: '8L-DEF456', payment_status: 'unpaid' },
    ],
  });
  assert.deepEqual(rows, [
    { reference: '8L-ABC123', status: 'verified_paid', stripe_reference: 'cs_paid' },
    { reference: '8L-DEF456', status: 'no_verified_payment' },
  ]);
});

test('catchup selects one earliest missing useful lifecycle email per booking', () => {
  const candidate = selectPacedLifecycleCandidate({
    verifiedStripe: true,
    daysUntilDeparture: 10,
    sentTemplates: new Set(['payment_confirmed']),
  });
  assert.equal(candidate, 'preparation_packing');
  assert.equal(selectPacedLifecycleCandidate({ verifiedStripe: false, daysUntilDeparture: 10, sentTemplates: new Set() }), null);
  assert.equal(selectPacedLifecycleCandidate({ verifiedStripe: true, daysUntilDeparture: -1, sentTemplates: new Set() }), null);
});

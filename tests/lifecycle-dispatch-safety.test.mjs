import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
async function source(path) { return readFile(new URL(path, root), 'utf8'); }

test('lifecycle dispatcher migration has one UTC-day claim, booking lock, and service-only RPCs', async () => {
  const sql = await source('supabase/migrations/20260915090000_lifecycle_dispatch_safety.sql');
  assert.match(sql, /create table public\.lifecycle_email_dispatches/i);
  assert.match(sql, /primary key\s*\(booking_id, utc_day\)/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /status='cancelled'/i);
  assert.match(sql, /status='queued'/i);
  assert.match(sql, /provider_attempted_at is not null/i);
  assert.match(sql, /claim_lifecycle_email_dispatch/i);
  assert.match(sql, /complete_lifecycle_email_dispatch/i);
  assert.match(sql, /revoke all on function[\s\S]*from public,anon,authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.match(sql, /enable row level security/i);
});

test('public cron claims and finalizes through the durable dispatcher rather than direct email-event insert/update', async () => {
  const route = await source('app/api/cron/drip-emails/route.ts');
  assert.match(route, /rpc\('claim_lifecycle_email_dispatch'/);
  assert.match(route, /rpc\('mark_lifecycle_email_provider_attempted'/);
  assert.match(route, /rpc\('complete_lifecycle_email_dispatch'/);
  assert.match(route, /8l-lifecycle-\$\{claim\.event_id\}/);
  assert.doesNotMatch(route, /from\('email_events'\)\.insert/);
});

test('runtime SQL exercises concurrent claims, queued-unknown blocking, failure retry, and cancellation fence', async () => {
  const sql = await source('tests/lifecycle-dispatch-runtime.sql');
  for (const marker of ['concurrent', 'queued unknown', 'definite failure', 'cancelled']) assert.match(sql, new RegExp(marker, 'i'));
  assert.match(sql, /first concurrent claimant did not win/i);
});

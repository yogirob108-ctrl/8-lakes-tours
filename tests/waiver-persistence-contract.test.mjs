import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = new URL('../supabase/migrations/20261007000000_rider_waivers.sql', import.meta.url);
const route = new URL('../app/api/waiver/route.ts', import.meta.url);

test('waiver persistence migration keeps signed evidence private, exact, and service-only', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /create table if not exists public\.rider_waivers/i);
  assert.match(sql, /signed_waiver_text text not null/i);
  assert.match(sql, /server_signed_at timestamptz not null/i);
  assert.match(sql, /lower\(coalesce\(t\.email, ''\)\) = lower\(trim\(p_rider_email\)\)/i);
  assert.match(sql, /guardian signature must match guardian name/i);
  assert.match(sql, /rider signature must match rider name/i);
  assert.match(sql, /create table if not exists public\.rider_waiver_email_dispatches/i);
  assert.match(sql, /reconciliation_required/i);
  assert.match(sql, /mark_rider_waiver_email_provider_attempted/i);
  assert.match(sql, /complete_rider_waiver_email_dispatch/i);
  assert.match(sql, /alter table public\.rider_waivers enable row level security/i);
  assert.match(sql, /revoke all on table public\.rider_waivers from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.rider_waivers to service_role/i);
  assert.match(sql, /create or replace function public\.record_rider_waiver/i);
  assert.match(sql, /service role required/i);
});

test('waiver API uses durable dispatch claims and does not reveal match status', async () => {
  const source = await readFile(route, 'utf8');
  assert.match(source, /record_rider_waiver/);
  assert.match(source, /claim_rider_waiver_email_dispatch/);
  assert.match(source, /mark_rider_waiver_email_provider_attempted/);
  assert.match(source, /complete_rider_waiver_email_dispatch/);
  assert.match(source, /signed_waiver_text/);
  assert.match(source, /trusted_ip_address/);
  assert.match(source, /reconciliation_required rather than a blind retry/i);
  assert.match(source, /return NextResponse\.json\(\{ ok: true \}\)/);
  assert.doesNotMatch(source, /pendingReview/);
  assert.match(source, /p_trusted_ip: record\.ipAddress/);
  assert.match(source, /x-vercel-forwarded-for/);
  assert.doesNotMatch(source, /x-forwarded-for/);
});

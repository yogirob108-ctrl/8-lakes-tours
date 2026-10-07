import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = new URL('../supabase/migrations/20261007000000_rider_waivers.sql', import.meta.url);
const route = new URL('../app/api/waiver/route.ts', import.meta.url);

test('waiver persistence migration keeps signed evidence private and service-only', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /create table if not exists public\.rider_waivers/i);
  assert.match(sql, /signed_waiver_text text not null/i);
  assert.match(sql, /server_signed_at timestamptz not null/i);
  assert.match(sql, /alter table public\.rider_waivers enable row level security/i);
  assert.match(sql, /revoke all on table public\.rider_waivers from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.rider_waivers to service_role/i);
  assert.match(sql, /create or replace function public\.record_rider_waiver/i);
  assert.match(sql, /service role required/i);
  assert.match(sql, /ambiguous/i);
  assert.match(sql, /guardian/i);
});

test('waiver API persists before email and only emails newly stored submissions', async () => {
  const source = await readFile(route, 'utf8');
  assert.match(source, /record_rider_waiver/);
  assert.match(source, /should_email/);
  assert.match(source, /if \(stored\.should_email\)/);
  assert.match(source, /x-vercel-forwarded-for/);
  assert.doesNotMatch(source, /x-forwarded-for/);
});

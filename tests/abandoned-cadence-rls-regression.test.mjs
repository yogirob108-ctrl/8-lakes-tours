import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = resolve('supabase/migrations/20260930000100_lock_abandoned_cadence_tables.sql');
const tables = [
  'public.abandoned_cadence_activation_log',
  'public.abandoned_cadence_booking_activation',
  'public.abandoned_cadence_rollout',
  'public.abandoned_cadence_stage2_cohort',
];

test('cadence rollout tables are locked to service_role in a durable migration', () => {
  assert.equal(existsSync(migration), true, 'the applied live lock must be committed');
  const sql = readFileSync(migration, 'utf8');
  assert.match(sql, /^BEGIN;\n/);
  assert.match(sql, /\nCOMMIT;\s*$/);
  for (const table of tables) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table.replace('.', '\\.')} ENABLE ROW LEVEL SECURITY;`));
  }
  assert.match(sql, /REVOKE ALL ON TABLE public\.abandoned_cadence_activation_log, public\.abandoned_cadence_booking_activation, public\.abandoned_cadence_rollout, public\.abandoned_cadence_stage2_cohort FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT ALL ON TABLE public\.abandoned_cadence_activation_log, public\.abandoned_cadence_booking_activation, public\.abandoned_cadence_rollout, public\.abandoned_cadence_stage2_cohort TO service_role;/);
});

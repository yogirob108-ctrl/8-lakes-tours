import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chunkValues, fetchAllPages } from '../lib/paginated-read.mjs';

test('fetchAllPages reads every consecutive page rather than silently retaining a first-page cap', async () => {
  const rows = Array.from({ length: 451 }, (_, index) => ({ id: index + 1 }));
  const calls = [];
  const received = await fetchAllPages(async (from, to) => {
    calls.push([from, to]);
    return rows.slice(from, to + 1);
  }, { pageSize: 200 });
  assert.equal(received.length, 451);
  assert.deepEqual(calls, [[0, 199], [200, 399], [400, 599]]);
});

test('chunkValues keeps booking-id filters bounded without dropping an id', () => {
  const values = Array.from({ length: 201 }, (_, index) => `booking-${index}`);
  const chunks = chunkValues(values, 100);
  assert.deepEqual(chunks.map(chunk => chunk.length), [100, 100, 1]);
  assert.deepEqual(chunks.flat(), values);
});

test('pagination helpers reject invalid page sizes', async () => {
  await assert.rejects(() => fetchAllPages(async () => [], { pageSize: 0 }), /positive integer/);
  assert.throws(() => chunkValues([], 0), /positive integer/);
});

test('both public lifecycle reads use range pagination rather than a 200-row cap', async () => {
  const root = new URL('..', import.meta.url);
  for (const path of ['app/api/cron/drip-emails/route.ts', 'app/api/cron/drip-emails/reconcile/route.ts']) {
    const source = await readFile(new URL(path, root), 'utf8');
    assert.match(source, /fetchAllPages/);
    assert.match(source, /\.range\(from, to\)/);
    assert.doesNotMatch(source, /\.limit\(200\)/);
  }
});

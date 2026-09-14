import assert from 'node:assert/strict';
import test from 'node:test';
import { composeDateOfBirth, splitDateOfBirth } from '../lib/date-of-birth-fields.mjs';

test('composes unpadded day-first values into canonical ISO dates', () => {
  assert.deepEqual(composeDateOfBirth('3', '2', '2004', { today: '2026-09-14' }), { value: '2004-02-03', error: '' });
});

test('rejects impossible calendar dates including non-leap-year February', () => {
  assert.match(composeDateOfBirth('29', '2', '2025', { today: '2026-09-14' }).error, /real calendar date/i);
  assert.deepEqual(composeDateOfBirth('29', '2', '2024', { today: '2026-09-14' }), { value: '2024-02-29', error: '' });
});

test('rejects future dates without imposing a new age limit', () => {
  assert.match(composeDateOfBirth('15', '9', '2026', { today: '2026-09-14' }).error, /future/i);
  assert.deepEqual(composeDateOfBirth('1', '1', '1900', { today: '2026-09-14' }), { value: '1900-01-01', error: '' });
});

test('keeps incomplete values empty and splits canonical dates for draft restoration', () => {
  assert.deepEqual(composeDateOfBirth('3', '', '2004', { today: '2026-09-14' }), { value: '', error: '' });
  assert.deepEqual(splitDateOfBirth('2004-02-03'), { day: '03', month: '02', year: '2004' });
  assert.deepEqual(splitDateOfBirth('not-a-date'), { day: '', month: '', year: '' });
});

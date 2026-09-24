import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8');

// A browser fires `input` and `change` as two separate tasks. Any state update
// run from `input` therefore re-renders BETWEEN them, and that render rewrites
// every controlled <select> back to its state value — silently discarding the
// option the visitor just picked. `change` then reports the reverted value, so
// the whole form looks inert while throwing no error at all.
//
// This shipped once: setValidationErrors was handed a fresh array from
// .filter() on every keystroke, which re-rendered unconditionally and killed
// the guest count, both genders, all three date-of-birth parts, the tour date
// and the riding level at once. These tests guard the shape that caused it.

test('clearFieldValidation keeps the same array when a field has no error to clear', () => {
  const body = client.slice(client.indexOf('const clearFieldValidation'));
  const fn = body.slice(0, body.indexOf('\n  };'));

  assert.match(fn, /setValidationErrors\(/, 'expected clearFieldValidation to still own this state');
  // The update must be able to bail out: it has to return `current` unchanged
  // on the common path where this field has no recorded error.
  assert.match(
    fn,
    /setValidationErrors\(current =>[\s\S]*?\?[\s\S]*?:\s*current\)/,
    'setValidationErrors must return the existing array when nothing matches, or every keystroke re-renders the form and controlled selects lose the value being picked',
  );
  assert.doesNotMatch(
    fn,
    /setValidationErrors\(current => current\.filter\([^)]*\)\)\s*;/,
    'an unconditional .filter() always yields a new array, so React re-renders on every input event',
  );
});

test('the form clears validation from input rather than from a per-keystroke render', () => {
  // onInput is where the clobbering render came from, so keep it visible here:
  // if another stateful call is added to that handler this test should be the
  // prompt to re-check the select behaviour in a real browser.
  const handler = client.slice(client.indexOf('onInput={event =>'));
  const inline = handler.slice(0, handler.indexOf('}}'));
  const stateCalls = inline.match(/\bset[A-Z]\w*\(/g) || [];
  assert.deepEqual(
    stateCalls,
    [],
    `onInput must not call setState directly (found ${stateCalls.join(', ')}); state updates there re-render between input and change and reset controlled selects`,
  );
});

test('every guest-facing dropdown is driven by a value the form controls', () => {
  // Controlled selects are the ones exposed to this failure mode. Naming them
  // keeps the browser regression test honest about what it has to cover.
  assert.match(client, /id="guest_count"[^>]*value=\{/, 'guest_count is expected to stay a controlled select');
  // The season pickers build their id from the year, so match that shape.
  assert.match(client, /id=\{selectId\}[\s\S]{0,200}value=\{chosen \? selectedTourDate : ''\}/, 'the season pickers are expected to stay controlled');
  assert.match(client, /value=\{parts\[part\]\}/, 'date-of-birth parts are expected to stay controlled');
});

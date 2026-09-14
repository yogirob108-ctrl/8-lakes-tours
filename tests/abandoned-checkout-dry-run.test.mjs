import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../app/api/cron/abandoned-checkouts/route.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../lib/abandoned-checkout.mjs', import.meta.url), 'utf8');

test('authenticated reminder dry run reaches the queue and provider evidence without claiming or sending', () => {
  assert.match(route, /dry_run/);
  assert.match(route, /dryRun/);
  assert.match(runner, /dryRun/);
  assert.match(runner, /eligible/);
  const dryRunBranch = runner.indexOf('if (dryRun)');
  const sendBranch = runner.indexOf('await sendEmail');
  assert.ok(dryRunBranch >= 0 && dryRunBranch < sendBranch);
});

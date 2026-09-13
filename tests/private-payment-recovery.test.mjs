import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
test('private recovery bypasses analytics layout and forbids scripts/referrers', () => {
 const base=new URL('../app/pay/',import.meta.url);
 assert.equal(existsSync(new URL('page.tsx',base)),false,'bearer tokens must not enter the analytics layout');
 const route=readFileSync(new URL('route.ts',base),'utf8');
 assert.match(route, /Content-Security-Policy/); assert.match(route,/default-src 'none'/);
 assert.match(route, /Referrer-Policy/); assert.match(route,/no-referrer/);
 assert.match(route, /Cache-Control/); assert.match(route,/no-store/);
});

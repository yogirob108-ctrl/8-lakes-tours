import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../app/HomePageClient.tsx',import.meta.url),'utf8');
test('payment UI uses server-issued recovery link and never generic Stripe product',()=>{
 assert.doesNotMatch(source,/book\.stripe\.com|<stripe-buy-button|buy-button-id/);
 assert.match(source,/setPaymentUrl\(payload.paymentUrl/);
 assert.match(source,/booking-save-spinner/);
 assert.match(source,/role="status" aria-live="polite"/);
 assert.match(source,/@media \(prefers-reduced-motion: reduce\)/);
});

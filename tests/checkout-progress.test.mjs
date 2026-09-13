import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const ui=readFileSync(new URL('../app/HomePageClient.tsx',import.meta.url),'utf8');
test('scheduled intake prepares checkout automatically without a pre-payment tick',()=>{
 assert.match(ui,/Preparing your secure checkout…/);
 assert.doesNotMatch(ui,/✓ (Booking|Request|Group booking) saved/);
 assert.match(ui,/await openSecureCheckout\(payload.paymentUrl\)/);
});

import {checkoutRoutes} from './checkout-route-harness.mjs';
test('automatic checkout receives the same guarded Stripe URL without following a cross-origin fetch redirect',async()=>{const response=await checkoutRoutes().POST(new Request('https://example.invalid/api/checkout',{method:'POST',headers:{accept:'application/json'},body:'reference=8L-TEST234&token=private'}));assert.equal(response.status,200);assert.equal((await response.json()).url,'https://checkout.stripe.com/c/pay/cs_test_fixture');assert.equal(response.headers.get('cache-control'),'no-store');});
test('private recovery never shows a saved tick before payment',async()=>{const response=await checkoutRoutes().GET(new Request('https://example.invalid/pay?reference=8L-TEST234&token=private'));const html=await response.text();assert.ok(!html.includes('✓'));assert.match(html,/Payment pending/);});

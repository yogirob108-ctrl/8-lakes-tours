// Run with PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs UI_BASE_URL=http://127.0.0.1:3107 node --test tests/checkout-card.browser.mjs
// Real rendered application; no API/DB response fixtures. Non-local network is blocked.
import test from 'node:test';import assert from 'node:assert/strict';
import {getGroupPricing} from '../lib/group-pricing.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
test.after(()=>browser.close());
for(const width of [390,1440])test(`checkout copy quotes whole booking, readable at ${width}px`,async()=>{
 const c=await browser.newContext({viewport:{width,height:1000}});
 await c.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 const p=await c.newPage();await p.goto(process.env.UI_BASE_URL);await p.waitForLoadState('networkidle');await p.locator('#tour_date').selectOption({index:1});
 for(let n=1;n<=8;n++){
  await p.locator('#guest_count').selectOption(String(n));
  const expected='$'+getGroupPricing(n).onlinePaymentUsd.toLocaleString('en-US');
  assert.ok((await p.locator('.payment-checkout-card .checkout-copy').innerText()).includes(expected),`group ${n}: online amount must be ${expected} for entire booking`);
 }
 await p.locator('#guest_count').selectOption('2');
 const colors=await p.locator('.stripe-preview-amount, .stripe-preview-amount span').evaluateAll(es=>es.map(e=>getComputedStyle(e).color));
 for(const color of colors){const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number);assert.ok(rgb.every(v=>v>120),`amount and guest label need light foreground on dark card, got ${color}`);}
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no viewport overflow');
 await c.close();
});

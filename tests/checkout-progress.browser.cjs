// Run against a local build: PLAYWRIGHT_PATH=/tmp/8l-browser-tools/node_modules/playwright node tests/checkout-progress.browser.cjs
(async()=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH+'/index.mjs' : 'playwright');
 const {default:assert}=await import('node:assert/strict');
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  const {getGroupPricing}=await import('../lib/group-pricing.mjs');
  const origin=process.env.LOCAL_TEST_ORIGIN || 'http://127.0.0.1:3318';
  assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  for(const scenario of [...Array.from({length:8},(_,i)=>i+1),'failed-checkout','failed-intake','private']) {
   const n=typeof scenario==='number'?scenario:1;
   const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
   let intake=0,checkouts=0,releaseIntake,releaseCheckout;
   const intakeGate=new Promise(r=>releaseIntake=r),checkoutGate=new Promise(r=>releaseCheckout=r);
   await page.route('**/*',async route=>{
    const url=route.request().url();
    if(url.startsWith('https://checkout.stripe.com/'))return route.fulfill({contentType:'text/html',body:'<h1>LOCAL STRIPE DESTINATION — NO PROVIDER CALL</h1>'});
    if(!url.startsWith(origin+'/'))return route.fulfill({status:200,body:''});
    if(url===origin+'/api/bookings'){
     intake++;
     const body=route.request().postDataJSON();
     assert.equal(body.travellers.length,n);assert.equal(Number(body.online_payment_usd),getGroupPricing(n).onlinePaymentUsd);
     await intakeGate;
     return route.fulfill({status:scenario==='failed-intake'?503:200,contentType:'application/json',body:JSON.stringify(scenario==='failed-intake'?{ok:false,error:'Local failure — try again'}:{ok:true,reference:'8L-TEST234',paymentUrl:scenario==='private'?null:'https://www.8lakestours.com/pay?reference=8L-TEST234&token=private-fixture'})});
    }
    if(url===origin+'/api/checkout'){
     checkouts++;assert.match(route.request().postData(),/token=private-fixture/);await checkoutGate;
     return route.fulfill({status:scenario==='failed-checkout'?409:200,contentType:'application/json',body:JSON.stringify(scenario==='failed-checkout'?{error:'Local checkout failure'}:{url:'https://checkout.stripe.com/c/pay/cs_test_local'})});
    }
    return route.continue();
   });
   await page.goto(origin,{waitUntil:'networkidle'});
   if(await page.getByRole('button',{name:'Necessary only',exact:true}).count())await page.getByRole('button',{name:'Necessary only',exact:true}).click();
   await page.locator('[name="guest_count"]').selectOption(String(n));
   assert.equal(await page.locator('input[name^="travellers."][name$=".first_name"]').count(),n-1);
   for(let i=0;i<n;i++){
    const prefix=i?`travellers.${i}.`:'';
    for(const [key,value] of Object.entries({first_name:'Local',last_name:'Fixture',nationality:'Testland',gender:'Female'}))await page.locator(`[name="${prefix}${key}"]`).fill(value);
    for(const [part,value] of Object.entries({day:'1',month:'1',year:'1990'}))await page.locator(`[name="${prefix}date_of_birth_${part}"]`).selectOption(value);
    await page.locator(`[name="${prefix}riding_experience"]`).selectOption({index:1});
   }
   await page.locator('#email').fill('local@example.invalid');
   await page.locator('[name="signature"]').fill('Local Fixture');
   await page.locator('[name="tour_date"]').selectOption(scenario==='private'?'2027 Private Group Date':{index:1});
   if(n>1)await page.locator('[name="companion_details_permission"]').check();
   await page.locator('#application .submit-btn').click();
   await page.waitForFunction(()=>document.querySelector('#application button[type="submit"]')?.disabled);
   assert.equal(await page.locator('#application').innerText().then(t=>/✓.*saved/i.test(t)),false);
   if(scenario!=='private')assert.match(await page.locator('#application .submit-btn').innerText(),/Preparing your secure checkout…/i);
   assert.equal(await page.locator('.booking-save-spinner').evaluate(el=>getComputedStyle(el).animationName),'none');
   await page.locator('#application form').evaluate(form=>form.requestSubmit());
   releaseIntake();
   if(scenario==='failed-intake'){
    await page.getByRole('alert').filter({hasText:'Local failure'}).waitFor();assert.equal(await page.locator('#first_name').inputValue(),'Local');assert.equal(checkouts,0);
   }else if(scenario==='private'){
    await page.getByRole('status').filter({hasText:'Request received.'}).waitFor();assert.equal(checkouts,0);
   }else{
    await page.waitForFunction(()=>document.querySelector('#application .submit-btn')?.textContent.includes('Preparing your secure checkout'));
    releaseCheckout();
    if(scenario==='failed-checkout'){
     await page.getByRole('alert').filter({hasText:'without submitting another booking'}).waitFor();assert.equal(await page.locator('#first_name').inputValue(),'Local');assert.match(await page.locator('.stripe-link-fallback').getAttribute('href'),/token=private-fixture/);
    }else await page.waitForURL('https://checkout.stripe.com/**');
    assert.equal(checkouts,1);
   }
   assert.equal(intake,1);
   console.log('PASS',scenario,'manifest',n,'intake',intake,'checkout',checkouts,'no pre-payment tick; reduced motion');
   await page.close();
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

(async()=>{
 const {chromium}=await import('/tmp/8l-live-check/node_modules/playwright/index.mjs');
 const assert=(await import('node:assert/strict')).default;
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try { for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
  const page=await browser.newPage({viewport,reducedMotion:'reduce'}); let bookings=0;
  await page.route('**/api/bookings',route=>{bookings++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,reference:'8L-TEST',paymentUrl:null})})});
  await page.goto('http://127.0.0.1:3318',{waitUntil:'networkidle'});
  if(await page.getByRole('button',{name:'Necessary only',exact:true}).count())await page.getByRole('button',{name:'Necessary only',exact:true}).click();
  await page.locator('#email').fill('test@example.invalid'); await page.locator('[name="signature"]').fill('Test Person');
  await page.locator('#application .submit-btn').click();
  await page.getByRole('alert').filter({hasText:'Check the highlighted fields'}).waitFor();
  assert.equal(bookings,0); assert.ok(await page.locator('[aria-invalid="true"]').count());
  assert.equal(await page.locator('input[name="date_of_birth_day"]').getAttribute('inputmode'),'numeric');
  assert.equal(await page.locator('input[name="date_of_birth_day"]').getAttribute('maxlength'),'2');
  assert.equal(await page.locator('input[name="date_of_birth_year"]').getAttribute('maxlength'),'4');
  assert.equal(await page.locator('input[name="date_of_birth_day"]').getAttribute('autocomplete'),'bday-day');
  await page.locator('[name="guest_count"]').selectOption('2');
  assert.equal(await page.locator('input[name="travellers.1.date_of_birth_day"]').getAttribute('autocomplete'),'off');
  await page.locator('input[name="date_of_birth_day"]').fill('29'); await page.locator('input[name="date_of_birth_month"]').fill('2'); await page.locator('input[name="date_of_birth_year"]').fill('2024');
  assert.equal(await page.locator('input[name="date_of_birth"]').inputValue(),'2024-02-29');
  await page.locator('input[name="date_of_birth_year"]').fill('2028'); await page.locator('input[name="date_of_birth_year"]').blur();
  await page.getByText('Date of birth cannot be in the future.').waitFor();
  console.log('PASS',viewport.width,'validation, day-first DOB, companion autocomplete, leap/future error'); await page.close();
 }} finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});

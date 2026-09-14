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
  assert.equal(await page.locator('select[name="date_of_birth_day"] option').count(),32);
  assert.equal(await page.locator('select[name="date_of_birth_month"] option').count(),13);
  assert.equal(await page.locator('select[name="date_of_birth_day"]').getAttribute('autocomplete'),'bday-day');
  await page.locator('[name="guest_count"]').selectOption('2');
  assert.equal(await page.locator('select[name="travellers.1.date_of_birth_day"]').getAttribute('autocomplete'),'off');
  await page.locator('select[name="date_of_birth_day"]').selectOption('29'); await page.locator('select[name="date_of_birth_month"]').selectOption('2'); await page.locator('select[name="date_of_birth_year"]').selectOption('2024');
  assert.equal(await page.locator('input[name="date_of_birth"]').inputValue(),'2024-02-29');
  await page.locator('select[name="date_of_birth_year"]').selectOption('2025');
  await page.getByText('Enter a real calendar date.').waitFor();
  console.log('PASS',viewport.width,'validation, day-first DOB, companion autocomplete, leap/future error'); await page.close();
 }} finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});

// Run after `npm run build && PORT=3321 npm run start` with PLAYWRIGHT_PATH set.
(async () => {
  const { chromium } = await import(`${process.env.PLAYWRIGHT_PATH}/index.mjs`);
  const assert = (await import('node:assert/strict')).default;
  const origin = process.env.LOCAL_TEST_ORIGIN || 'http://127.0.0.1:3321';
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });

  async function dismissConsent(page) {
    const necessary = page.getByRole('button', { name: 'Necessary only', exact: true });
    if (await necessary.count()) await necessary.click();
  }

  async function fillBookingFields(page) {
    await page.locator('#first_name').fill('Local');
    await page.locator('#last_name').fill('Fixture');
    await page.locator('#nationality').fill('Testland');
    await page.locator('#gender').selectOption('Female');
    await page.locator('[name="date_of_birth_day"]').selectOption('1');
    await page.locator('[name="date_of_birth_month"]').selectOption('1');
    await page.locator('[name="date_of_birth_year"]').selectOption('1990');
    await page.locator('#riding_experience').selectOption({ index: 1 });
    await page.locator('#signature').fill('Local Fixture');
    await page.locator('[name="waiver_agreed"]').check();
  }

  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      let bookings = 0;
      let checkoutRequests = 0;
      await page.route('**/api/bookings', route => {
        bookings += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, reference: '8L-EMAIL', paymentUrl: null }) });
      });
      await page.route('**/api/checkout', route => { checkoutRequests += 1; return route.abort(); });
      await page.goto(origin, { waitUntil: 'networkidle' });
      await dismissConsent(page);
      assert.equal(await page.locator('.form-inline-validation-error').count(), 0, `${viewport.width}px untouched form has no email errors`);

      await page.locator('#email').fill('rider@domain');
      await page.locator('#email').blur();
      await page.locator('#email-inline-error').waitFor();
      assert.equal(await page.locator('#email').getAttribute('aria-invalid'), 'true');
      assert.match(await page.locator('#email').getAttribute('aria-describedby'), /email-inline-error/);
      await fillBookingFields(page);
      await page.locator('#application form').evaluate(form => form.requestSubmit());
      await page.waitForTimeout(100);
      assert.equal(bookings, 0, `${viewport.width}px malformed email makes no booking POST`);
      assert.equal(checkoutRequests, 0, `${viewport.width}px malformed email opens no Stripe checkout`);

      await page.locator('#email').fill(' rider+tag@updates.example.co.uk ');
      await page.locator('#email').blur();
      assert.equal(await page.locator('#email-inline-error').count(), 0, `${viewport.width}px valid corrected email clears its error`);
      assert.equal(await page.locator('#email').getAttribute('aria-invalid'), null);
      await page.locator('#application .submit-btn').click();
      await page.waitForTimeout(250);
      assert.equal(bookings, 1, `${viewport.width}px valid email passes the email gate`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Run after `npm run build && PORT=3319 npm run start`.
(async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? `${process.env.PLAYWRIGHT_PATH}/index.mjs` : 'playwright');
  const assert = (await import('node:assert/strict')).default;
  const origin = process.env.LOCAL_TEST_ORIGIN || 'http://127.0.0.1:3319';
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const scheduledDate = 'October 7 – 15, 2026';
  const privateDate = '2026 Private Group Date';
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });

  async function dismissConsent(page) {
    if (await page.getByRole('button', { name: 'Necessary only', exact: true }).count()) {
      await page.getByRole('button', { name: 'Necessary only', exact: true }).click();
    }
  }

  async function fillValidForm(page, date) {
    await page.locator('#first_name').fill('Local');
    await page.locator('#last_name').fill('Fixture');
    await page.locator('#email').fill('local@example.invalid');
    await page.locator('#nationality').fill('Testland');
    await page.locator('[name="date_of_birth_day"]').fill('1');
    await page.locator('[name="date_of_birth_month"]').fill('1');
    await page.locator('[name="date_of_birth_year"]').fill('1990');
    await page.locator('#riding_experience').selectOption({ index: 1 });
    await page.locator('#tour_date').selectOption(date);
    await page.locator('[name="signature"]').fill('Local Fixture');
  }

  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      let loadRelease;
      const loadGate = new Promise(resolve => { loadRelease = resolve; });
      let storedTourDate = '';
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      await page.addInitScript(() => sessionStorage.setItem('8l_checkout_draft', JSON.stringify({ draft_id: 'draft-local', credential: 'credential-local' })));
      await page.route('**/api/checkout-draft', async route => {
        const body = route.request().postDataJSON();
        if (body.action === 'load') {
          await loadGate;
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, draft: { tour_date: storedTourDate } }) });
        }
        storedTourDate = body.tour_date || storedTourDate;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, draft_id: 'draft-local', credential: 'credential-local' }) });
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await dismissConsent(page);
      await page.locator('#tour_date').selectOption(scheduledDate);
      await page.locator('#notes').fill('A later edit must not clear the selected departure.');
      loadRelease();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#tour_date').inputValue(), scheduledDate, `${viewport.width}px delayed restore kept the user date`);
      await page.waitForTimeout(800);
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('#tour_date').inputValue(), scheduledDate, `${viewport.width}px autosave/reload restored the date`);
      console.log('PASS', viewport.width, 'date persists through delayed restore, edit, autosave, reload');
      await page.close();
    }

    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    let bookings = 0;
    await page.route('**/api/bookings', route => { bookings++; return route.fulfill({ status: 500, body: 'unexpected' }); });
    await page.goto(origin, { waitUntil: 'networkidle' });
    await dismissConsent(page);
    await fillValidForm(page, scheduledDate);
    await page.locator('#tour_date').selectOption('');
    await page.locator('#application form').evaluate(form => form.requestSubmit());
    await page.locator('#tour_date-inline-error').filter({ hasText: 'Choose a tour date before continuing.' }).waitFor();
    assert.match(await page.locator('.booking-error-summary').innerText(), /Choose a tour date before continuing\./);
    assert.equal(bookings, 0, 'placeholder date never reaches the booking API');
    assert.equal(await page.locator('#tour_date').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tour_date');
    console.log('PASS empty date blocks API, focuses date, and has inline/summary error');
    await page.close();

    const privacyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await privacyPage.goto(origin, { waitUntil: 'networkidle' });
    await dismissConsent(privacyPage);
    assert.equal(await privacyPage.locator('.privacy-choice-trigger').count(), 0, 'saved choice has no persistent floating privacy tab');
    await privacyPage.locator('.privacy-choices-link').scrollIntoViewIfNeeded();
    await privacyPage.locator('.privacy-choices-link').click();
    await privacyPage.getByRole('region', { name: 'Privacy choices' }).waitFor();
    console.log('PASS footer Privacy choices reopens the same consent controls');
    await privacyPage.close();

    for (const [date, paymentUrl] of [[scheduledDate, 'https://www.8lakestours.com/pay?reference=8L-TEST&token=local'], [privateDate, null]]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      let bookings = 0;
      await page.route('**/api/bookings', route => { bookings++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, reference: '8L-TEST', paymentUrl }) }); });
      await page.route('**/api/checkout', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_local' }) }));
      await page.route('https://checkout.stripe.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Local Stripe target</h1>' }));
      await page.goto(origin, { waitUntil: 'networkidle' });
      await dismissConsent(page);
      await fillValidForm(page, date);
      await page.locator('#application .submit-btn').click();
      if (paymentUrl) await page.waitForURL('https://checkout.stripe.com/**');
      else await page.getByRole('status').filter({ hasText: 'Request received.' }).waitFor();
      assert.equal(bookings, 1);
      console.log('PASS', paymentUrl ? 'scheduled Book & pay' : 'private availability request');
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

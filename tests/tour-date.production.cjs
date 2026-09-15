// Safe public smoke: no complete booking, provider, email, or charge is triggered.
(async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? `${process.env.PLAYWRIGHT_PATH}/index.mjs` : 'playwright');
  const assert = (await import('node:assert/strict')).default;
  const origin = process.env.PRODUCTION_ORIGIN || 'https://www.8lakestours.com';
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      let bookingRequests = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/bookings') bookingRequests++; });
      await page.goto(origin, { waitUntil: 'networkidle' });
      if (await page.getByRole('button', { name: 'Necessary only', exact: true }).count()) await page.getByRole('button', { name: 'Necessary only', exact: true }).click();
      const select = page.locator('#tour_date');
      const scheduled = await select.locator('option:not([value=""])').nth(0).getAttribute('value');
      const privateDate = await select.locator('option[value*="on request"]').last().getAttribute('value');
      assert.ok(scheduled && privateDate);
      assert.equal(await select.getAttribute('required'), '');
      await select.selectOption(scheduled);
      await page.locator('#notes').fill('Safe production UI smoke edit.');
      await page.waitForTimeout(800);
      assert.equal(await select.inputValue(), scheduled, `${viewport.width}px scheduled selection persists`);
      await select.selectOption(privateDate);
      assert.match(await select.inputValue(), /on request/, `${viewport.width}px unified private request selection persists`);
      await select.selectOption('');
      await page.locator('#application form').evaluate(form => form.requestSubmit());
      await page.locator('#tour_date-inline-error').waitFor();
      assert.match(await page.locator('.booking-error-summary').innerText(), /Choose a tour date before continuing\./);
      assert.equal(bookingRequests, 0, 'incomplete empty-date validation made no booking API request');
      assert.equal(await page.locator('.privacy-choice-trigger').count(), 0, 'no persistent privacy overlay after saved choice');
      await page.locator('.privacy-choices-link').scrollIntoViewIfNeeded();
      await page.locator('.privacy-choices-link').click();
      await page.getByRole('region', { name: 'Privacy choices' }).waitFor();
      console.log('PASS production', viewport.width, 'scheduled/private selection, empty validation/no API, footer privacy control');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

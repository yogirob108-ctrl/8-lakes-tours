// Run after `npm run build && PORT=3320 npm run start`:
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/funnel-instrumentation.browser.cjs
// The app is real; GA and booking transport are mocked. No provider is contacted.
(async () => {
  if (!process.env.PLAYWRIGHT_MODULE) throw new Error('PLAYWRIGHT_MODULE must point to playwright/index.mjs');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const assert = (await import('node:assert/strict')).default;
  const origin = process.env.LOCAL_TEST_ORIGIN || 'http://127.0.0.1:3320';
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://www.googletagmanager.com/gtag/js**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(`${origin}/`)) return route.abort();
      if (url === `${origin}/api/bookings`) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, reference: '8L-TEST234', paymentUrl: 'https://www.8lakestours.com/pay?reference=8L-TEST234&token=fixture' }) });
      }
      if (url === `${origin}/api/checkout`) {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'mocked checkout failure' }) });
      }
      return route.continue();
    });

    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Allow measurement', exact: true }).click();
    await page.locator('.hero-actions .btn-primary').click();
    await page.locator('#trip-details').scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);

    await page.locator('[name="guest_count"]').selectOption('1');
    for (const [name, value] of Object.entries({ first_name: 'Fixture', last_name: 'Person', nationality: 'Testland', signature: 'Fixture Person' })) {
      await page.locator(`[name="${name}"]`).fill(value);
    }
    await page.locator('[name="gender"]').selectOption('Female');
    await page.locator('[name="date_of_birth_day"]').selectOption('1');
    await page.locator('[name="date_of_birth_month"]').selectOption('1');
    await page.locator('[name="date_of_birth_year"]').selectOption('1990');
    await page.locator('[name="riding_experience"]').selectOption({ index: 1 });
    await page.locator('#email').fill('fixture@example.invalid');
    await page.locator('[name="tour_date"]').selectOption({ index: 1 });
    await page.locator('[name="waiver_agreed"]').check();
    await page.locator('#application .submit-btn').click();
    await page.getByRole('alert').filter({ hasText: 'without submitting another booking' }).waitFor();

    const events = await page.evaluate(() => Array.from(window.dataLayer || [])
      .filter((entry) => entry && entry[0] === 'event')
      .map((entry) => ({ name: entry[1], properties: entry[2] })));
    const byName = Object.fromEntries(events.map(event => [event.name, event.properties]));
    for (const name of ['booking_cta_click', 'view_tour', 'booking_form_start', 'booking_form_submit']) assert.ok(byName[name], `expected ${name} from the real rendered flow`);
    assert.equal(byName.begin_checkout, undefined, 'failed checkout must not claim a created checkout session');
    assert.equal(byName.checkout_redirect_started, undefined, 'failed checkout must not claim a redirect');
    for (const event of events) {
      const payload = JSON.stringify(event.properties || {});
      assert.doesNotMatch(payload, /8L-TEST234|fixture@example\.invalid|reference/i, `${event.name} leaked an identifier`);
    }
    console.log('funnel browser: mocked failure emitted no false checkout stages and no identifiers');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

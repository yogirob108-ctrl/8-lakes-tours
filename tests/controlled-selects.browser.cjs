// Run after `npm run build && PORT=3319 npm run start`.
//
// Playwright's selectOption dispatches the real `input` and `change` pair the
// way a person's click does — in separate tasks, with a render able to land
// between them. Scripted `dispatchEvent` calls in one task get batched by React
// and hide that window entirely, which is exactly how a bug that broke every
// dropdown on the booking form reached production while hand-written DOM checks
// kept passing. Anything asserting that a control "works" belongs here.
(async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? `${process.env.PLAYWRIGHT_PATH}/index.mjs` : 'playwright');
  const assert = (await import('node:assert/strict')).default;
  const origin = process.env.LOCAL_TEST_ORIGIN || 'http://127.0.0.1:3319';
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  const failures = [];

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    if (await page.getByRole('button', { name: 'Necessary only', exact: true }).count()) {
      await page.getByRole('button', { name: 'Necessary only', exact: true }).click();
    }

    // Holding a picked value is the whole point: read it back after the render
    // the pick triggers, not before.
    const holds = async (selector, value, label) => {
      await page.locator(selector).selectOption(value);
      const settled = await page.locator(selector).inputValue();
      if (settled !== value) failures.push(`${label}: picked ${value}, form kept ${settled}`);
    };

    await holds('#guest_count', '3', 'guest count');
    const sheets = await page.locator('.companion-fields').count();
    assert.equal(sheets, 2, `3 guests must render 2 companion sheets, got ${sheets}`);
    assert.match(
      await page.locator('.group-pricing-card').innerText(),
      /1,949/,
      '3 guests must reprice to the 3-4 tier',
    );

    await holds('#gender', 'Non-binary', 'lead gender');
    await holds('#riding_experience', 'Advanced — experienced rider', 'riding level');
    await holds('[name="date_of_birth_day"]', '14', 'lead date of birth day');
    await holds('[name="date_of_birth_month"]', '7', 'lead date of birth month');
    await holds('[name="date_of_birth_year"]', '1990', 'lead date of birth year');

    // The composed hidden field is what the booking API actually receives.
    assert.equal(
      await page.locator('input[name="date_of_birth"]').inputValue(),
      '1990-07-14',
      'the three date parts must compose into the submitted value',
    );

    // Companion controls are rendered later than the lead ones, so cover both.
    await holds('[name="travellers.1.gender"]', 'Female', 'companion gender');
    await holds('[name="travellers.1.riding_experience"]', 'Beginner — little to none', 'companion riding level');
    await holds('[name="travellers.1.date_of_birth_month"]', '4', 'companion date of birth month');

    // Shrinking the group must drop the surplus sheets rather than strand them.
    await holds('#guest_count', '2', 'guest count back down');
    const shrunk = await page.locator('.companion-fields').count();
    assert.equal(shrunk, 1, `2 guests must leave 1 companion sheet, got ${shrunk}`);

    assert.deepEqual(failures, [], `controls lost the value that was picked:\n  ${failures.join('\n  ')}`);
    console.log('controlled selects: every dropdown held its picked value');
  } finally {
    await browser.close();
  }
})();

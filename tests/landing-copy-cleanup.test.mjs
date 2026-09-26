import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const homepageUrl = new URL('../app/HomePageClient.tsx', import.meta.url);
const paidLandingUrl = new URL('../app/horse-trekking-mongolia/page.tsx', import.meta.url);
const faqUrl = new URL('../app/faq/page.tsx', import.meta.url);
const datesUrl = new URL('../lib/tour-dates.mjs', import.meta.url);
const llmsUrl = new URL('../public/llms.txt', import.meta.url);
const llmsFullUrl = new URL('../public/llms-full.txt', import.meta.url);

const foundingRatePromotion = /founding\s*(rate|price)|book\s*(a\s*)?2027[^.]*2026|2027[^.]*2026[^.]*price|pay\s*2026\s*prices/i;

test('published booking copy has no founding-rate promotion', async () => {
  const [homepage, paidLanding, faq, dates, llms, llmsFull] = await Promise.all([
    readFile(homepageUrl, 'utf8'),
    readFile(paidLandingUrl, 'utf8'),
    readFile(faqUrl, 'utf8'),
    readFile(datesUrl, 'utf8'),
    readFile(llmsUrl, 'utf8'),
    readFile(llmsFullUrl, 'utf8'),
  ]);

  for (const source of [homepage, paidLanding, faq, dates, llms, llmsFull]) {
    assert.doesNotMatch(source, foundingRatePromotion);
  }
});

test('homepage booking copy keeps pricing and dates without year-based selling', async () => {
  const homepage = await readFile(homepageUrl, 'utf8');

  assert.match(homepage, /<h2 className="section-title">Reserve your spot<\/h2>/);
  assert.match(homepage, /The trip is \$1,999 per person, and group rates apply for 3–8 guests\./);
  assert.doesNotMatch(homepage, /Limited Availability/i);
  assert.doesNotMatch(homepage, /season — founding rate/i);
  assert.doesNotMatch(homepage, /founding-rate-line/);
});

test('paid-search landing uses a neutral booking call to action', async () => {
  const source = await readFile(paidLandingUrl, 'utf8');

  assert.match(source, /label="Reserve your spot"/);
  assert.doesNotMatch(source, /Book 2027 dates|Request 2027 availability|2027 Mongolia/i);
});

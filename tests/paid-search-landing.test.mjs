import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pageUrl = new URL('../app/horse-trekking-mongolia/page.tsx', import.meta.url);
const sitemapUrl = new URL('../app/sitemap.ts', import.meta.url);

test('paid-search landing page states the exact offer and request-only 2027 inventory', async () => {
  const source = await readFile(pageUrl, 'utf8');

  assert.match(source, /9-day/i);
  assert.match(source, /Orkhon Valley/i);
  assert.match(source, /Naiman Nuur|Eight Lakes/i);
  assert.match(source, /\$1,799–\$1,999/);
  assert.match(source, /\$899–\$999 pp/);
  assert.match(source, /\$900–\$1,000 pp/);
  assert.match(source, /2027 small-group dates are being planned/i);
  assert.match(source, /private 2027 departures.*request/i);
  assert.doesNotMatch(source, /2027-\d{2}-\d{2}/);
});

test('landing page foregrounds trust, suitability and one clear enquiry path', async () => {
  const source = await readFile(pageUrl, 'utf8');

  assert.match(source, /Robert Zaher/);
  assert.match(source, /nomadic host family/i);
  assert.match(source, /beginner/i);
  assert.match(source, /maximum 8|max 8/i);
  assert.match(source, /travel insurance/i);
  assert.match(source, /href="\/#application"/);
});

test('paid-search landing retains canonical metadata but is excluded from organic index', async () => {
  const [page, sitemap] = await Promise.all([
    readFile(pageUrl, 'utf8'),
    readFile(sitemapUrl, 'utf8'),
  ]);

  assert.match(page, /https:\/\/www\.8lakestours\.com\/horse-trekking-mongolia/);
  assert.doesNotMatch(sitemap, /\$\{siteUrl\}\/horse-trekking-mongolia/);
  assert.match(page, /robots: \{ index: false, follow: true \}/);
});

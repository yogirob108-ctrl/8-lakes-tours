import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const campaignDir = new URL('../docs/marketing/google-ads-september-2026-test/', import.meta.url);

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if (character === '\n' && !quoted) {
      row.push(field.replace(/\r$/, ''));
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  assert.equal(quoted, false, 'CSV contains an unterminated quoted field');
  return rows;
}

test('homepage gives late-season visitors a clear September–October booking path', async () => {
  const [source, tourDatesSource] = await Promise.all([
    readFile(new URL('../app/HomePageClient.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/tour-dates.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /lateSeasonDepartures\.length > 0/);
  assert.match(source, /Book September–October 2026/);
  assert.doesNotMatch(source, /lateSeasonDateLabel/);
  assert.doesNotMatch(source, /September places available|last places|only \d+ places/i);

  for (const date of [
    'September 14 – 22, 2026',
    'September 23 – October 1, 2026',
    'October 7 – 15, 2026',
    'October 21 – 29, 2026',
  ]) {
    assert.match(tourDatesSource, new RegExp(`${date}[^\\n]+status: 'Open · max 8'`));
  }
  assert.doesNotMatch(tourDatesSource, /startDate:[^\n]+requiresConfirmation: true/);
});

test('campaign pack is paused, homepage-led, narrow and bounded to the approved test', async () => {
  const [brief, keywords, negatives, ads] = await Promise.all([
    readFile(new URL('README.md', campaignDir), 'utf8'),
    readFile(new URL('keywords.csv', campaignDir), 'utf8'),
    readFile(new URL('negative-keywords.csv', campaignDir), 'utf8'),
    readFile(new URL('responsive-search-ad.csv', campaignDir), 'utf8'),
  ]);
  const all = `${brief}\n${keywords}\n${negatives}\n${ads}`;

  assert.match(brief, /\$7(?:\.00)? per day/i);
  assert.match(brief, /7 calendar days/i);
  assert.match(brief, /August 30, 2026/i);
  assert.match(brief, /campaign end date.*September 5, 2026/i);
  assert.match(brief, /\$55.*manual.*stop|manual.*stop.*\$55/i);
  assert.match(brief, /Google Search only/i);
  assert.match(brief, /Search Partners.*off/i);
  assert.match(brief, /Display.*off/i);
  assert.match(brief, /presence/i);
  assert.match(all, /PAUSED/i);
  assert.doesNotMatch(keywords, /,Broad,/i);
  assert.match(keywords, /https:\/\/www\.8lakestours\.com\/\?utm_source=google&utm_medium=cpc&utm_campaign=september_2026_last_minute/);
  assert.match(negatives, /adventure therapy/i);
  assert.match(ads, /September Dates Now Open/i);
  assert.doesNotMatch(ads, /last places|only \d+ places|guaranteed availability/i);
});

test('responsive search ad CSV is valid and assets respect Google character limits', async () => {
  const source = await readFile(new URL('responsive-search-ad.csv', campaignDir), 'utf8');
  const [header, ...data] = parseCsv(source);
  assert.deepEqual(header, ['asset_type', 'text', 'status']);
  data.forEach(row => assert.equal(row.length, header.length, `malformed CSV row: ${JSON.stringify(row)}`));
  const rows = data.map(([type, text, status]) => ({ type, text, status }));

  const headlines = rows.filter(row => row.type === 'headline');
  const descriptions = rows.filter(row => row.type === 'description');
  assert.ok(headlines.length >= 8 && headlines.length <= 15);
  assert.ok(descriptions.length >= 2 && descriptions.length <= 4);
  headlines.forEach(({ text }) => assert.ok(text.length <= 30, `headline too long: ${text}`));
  descriptions.forEach(({ text }) => assert.ok(text.length <= 90, `description too long: ${text}`));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttributionCapture, normalizeAttributionPayload } from '../lib/booking-attribution.mjs';

const NOW = '2026-11-03T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

function visit(path, { referrer = '', now = NOW, stored = null, consent = false } = {}) {
  return buildAttributionCapture({
    locationHref: `https://www.8lakestours.com${path}`,
    referrer,
    now,
    stored,
    measurementConsent: consent,
    gaClientId: consent ? '12345.67890' : '',
    gaSessionId: consent ? '67890' : '',
  });
}

test('captures a fresh tagged landing as timestamped first and most recent eligible attribution', () => {
  const result = visit('/?utm_source=chatgpt.com&utm_medium=referral&utm_campaign=autumn&gclid=abc123', {
    referrer: 'https://chatgpt.com/share/example',
    consent: true,
  });

  assert.equal(result.first_touch.captured_at, NOW);
  assert.equal(result.first_touch.tagged_link.source, 'chatgpt.com');
  assert.equal(result.first_touch.observed_referrer.host, 'chatgpt.com');
  assert.equal(result.most_recent_eligible.captured_at, NOW);
  assert.equal(result.current_visit.type, 'tagged_campaign');
  assert.equal(result.current_visit.ga_client_id, '12345.67890');
  assert.equal(result.current_visit.ga_session_id, '67890');
  assert.equal(result.current_visit.click_ids.gclid, 'abc123');
});

test('records a direct visit explicitly without overwriting the most recent eligible source', () => {
  const tagged = visit('/?utm_source=google&utm_medium=cpc&utm_campaign=summer');
  const direct = visit('/#booking', { stored: tagged.storage, now: '2026-11-05T12:00:00.000Z' });

  assert.equal(direct.current_visit.type, 'direct');
  assert.equal(direct.most_recent_eligible.tagged_link.source, 'google');
  assert.equal(direct.first_touch.tagged_link.source, 'google');
});

test('replaces the most recent eligible attribution for a competing later campaign while retaining first touch', () => {
  const first = visit('/?utm_source=google&utm_medium=cpc&utm_campaign=summer');
  const second = visit('/?utm_source=newsletter&utm_medium=email&utm_campaign=november', {
    stored: first.storage,
    now: '2026-11-06T12:00:00.000Z',
  });

  assert.equal(second.first_touch.tagged_link.source, 'google');
  assert.equal(second.most_recent_eligible.tagged_link.source, 'newsletter');
});

test('expires first-touch storage after the documented 30-day TTL', () => {
  const first = visit('/?utm_source=google&utm_medium=cpc');
  const expired = visit('/?utm_source=partner&utm_medium=referral', {
    stored: first.storage,
    now: new Date(Date.parse(NOW) + 30 * DAY + 1).toISOString(),
  });

  assert.equal(expired.first_touch.tagged_link.source, 'partner');
  assert.equal(expired.first_touch.captured_at, new Date(Date.parse(NOW) + 30 * DAY + 1).toISOString());
});

test('rejects corrupt storage and captures honest unknown/direct evidence instead', () => {
  const result = visit('/#booking', { stored: '{not-json' });

  assert.equal(result.first_touch, undefined);
  assert.equal(result.most_recent_eligible, undefined);
  assert.equal(result.current_visit.type, 'direct');
  assert.equal(result.current_visit.observed_referrer, undefined);
});

test('withdrawn measurement consent removes GA and click IDs without changing non-analytics capture semantics', () => {
  const first = visit('/?utm_source=google&utm_medium=cpc&gclid=abc123', { consent: true });
  const withdrawn = visit('/#booking', { stored: first.storage, consent: false });

  assert.equal(withdrawn.current_visit.ga_client_id, undefined);
  assert.equal(withdrawn.current_visit.ga_session_id, undefined);
  assert.equal(withdrawn.current_visit.click_ids, undefined);
  assert.equal(withdrawn.first_touch.tagged_link.source, 'google');
  assert.equal(first.first_touch.tagged_link.click_ids, undefined, 'click IDs never persist in first-touch storage');
  assert.equal(withdrawn.first_touch.tagged_link.click_ids, undefined, 'withdrawal cannot replay a previously captured click ID');
});

test('internal referrers are not observed external referrals', () => {
  const result = visit('/#booking', { referrer: 'https://www.8lakestours.com/about' });

  assert.equal(result.current_visit.type, 'direct');
  assert.equal(result.current_visit.observed_referrer, undefined);
});

test('server normalization strips queries, fragments, unsupported fields, and unsafe campaign values', () => {
  const normalized = normalizeAttributionPayload({
    version: 1,
    first_touch: {
      captured_at: NOW,
      tagged_link: { source: 'google', medium: 'cpc', campaign: '<bad>', landing: 'https://www.8lakestours.com/?email=guest@example.com#private' },
      observed_referrer: { host: 'www.google.com', path: '/search?q=private' },
    },
    current_visit: { captured_at: NOW, type: 'tagged_campaign', page: 'https://www.8lakestours.com/booking?token=secret#form', unexpected: 'nope' },
  });

  assert.deepEqual(normalized, {
    version: 1,
    first_touch: {
      captured_at: NOW,
      tagged_link: { source: 'google', medium: 'cpc', landing: { host: 'www.8lakestours.com', path: '/' } },
      observed_referrer: { host: 'www.google.com', path: '/search' },
    },
    current_visit: { captured_at: NOW, type: 'tagged_campaign', page: { host: 'www.8lakestours.com', path: '/booking' } },
  });
});

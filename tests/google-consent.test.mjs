import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONSENT_STORAGE_KEY,
  GOOGLE_CONSENT_DEFAULTS,
  cookieDomainsForHostname,
  consentUpdateForChoice,
  normalizeConsentChoice,
} from '../lib/google-consent.mjs';

test('Google consent defaults deny analytics and advertising storage', () => {
  assert.deepEqual(GOOGLE_CONSENT_DEFAULTS, {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    wait_for_update: 500,
  });
});

test('measurement acceptance grants analytics and non-personalized ads measurement', () => {
  assert.deepEqual(consentUpdateForChoice('measurement'), {
    ad_storage: 'granted',
    analytics_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'denied',
  });
});

test('necessary-only choice keeps all optional Google consent denied', () => {
  assert.deepEqual(consentUpdateForChoice('necessary'), {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
});

test('stored consent accepts only known choices', () => {
  assert.equal(CONSENT_STORAGE_KEY, 'eight_lakes_google_consent');
  assert.equal(normalizeConsentChoice('measurement'), 'measurement');
  assert.equal(normalizeConsentChoice('necessary'), 'necessary');
  assert.equal(normalizeConsentChoice('granted'), null);
  assert.equal(normalizeConsentChoice(null), null);
});

test('consent withdrawal covers both www and parent-domain Google cookies', () => {
  assert.deepEqual(cookieDomainsForHostname('www.8lakestours.com'), ['www.8lakestours.com', '8lakestours.com']);
  assert.deepEqual(cookieDomainsForHostname('8lakestours.com'), ['8lakestours.com']);
});

test('privacy policy explains consent-controlled Google Ads measurement', async () => {
  const [policy, banner] = await Promise.all([
    readFile(new URL('../app/privacy/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/GoogleConsentBanner.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(policy, /Google Ads conversion measurement/i);
  assert.match(policy, /non-personalized/i);
  assert.match(policy, /cookieless/i);
  assert.match(policy, /change.*privacy choices/i);
  assert.match(banner, /cookieless/i);
});

test('Google loads only after the visitor explicitly allows measurement', async () => {
  const [source, banner] = await Promise.all([
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/GoogleConsentBanner.tsx', import.meta.url), 'utf8'),
  ]);
  const defaultsIndex = source.indexOf('google-consent-defaults');

  assert.notEqual(defaultsIndex, -1);
  assert.doesNotMatch(source, /googletagmanager\.com\/gtag\/js/);
  assert.match(banner, /googletagmanager\.com\/gtag\/js/);
  assert.match(banner, /nextChoice === 'measurement'/);
  assert.match(source, /GoogleConsentBanner/);
});

test('the first-visit consent notice is present in server HTML before hydration', async () => {
  const banner = await readFile(new URL('../app/components/GoogleConsentBanner.tsx', import.meta.url), 'utf8');
  assert.match(banner, /useState\(true\)/);
  assert.doesNotMatch(banner, /requestAnimationFrame/);
});

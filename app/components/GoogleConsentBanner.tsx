"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  CONSENT_STORAGE_KEY,
  cookieDomainsForHostname,
  consentUpdateForChoice,
  normalizeConsentChoice,
} from '@/lib/google-consent.mjs';

type ConsentChoice = 'measurement' | 'necessary';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

function clearGoogleAnalyticsCookies() {
  document.cookie.split(';').forEach(cookie => {
    const name = cookie.split('=')[0]?.trim();
    if (!name || (name !== '_ga' && !name.startsWith('_ga_'))) return;
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
    cookieDomainsForHostname(window.location.hostname).forEach(domain => {
      document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.${domain}; SameSite=Lax`;
    });
  });
}

export default function GoogleConsentBanner() {
  const [isOpen, setIsOpen] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const stored = normalizeConsentChoice(window.localStorage.getItem(CONSENT_STORAGE_KEY)) as ConsentChoice | null;
    if (stored) {
      window.gtag?.('consent', 'update', consentUpdateForChoice(stored));
    }

    const frame = window.requestAnimationFrame(() => {
      if (!stored) setIsOpen(true);
      setIsReady(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const openChoices = () => setIsOpen(true);
    window.addEventListener('eight-lakes:open-privacy-choices', openChoices);
    return () => window.removeEventListener('eight-lakes:open-privacy-choices', openChoices);
  }, []);

  function saveChoice(nextChoice: ConsentChoice) {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, nextChoice);
    window.gtag?.('consent', 'update', consentUpdateForChoice(nextChoice));
    if (nextChoice === 'necessary') clearGoogleAnalyticsCookies();
    setIsOpen(false);
  }

  if (!isReady) return null;

  return (
    <>
      {isOpen ? (
        <section className="consent-panel" aria-label="Privacy choices" aria-live="polite">
          <div>
            <p className="consent-kicker">Privacy choices</p>
            <h2>Choose how Google measurement works.</h2>
            <p>
              Necessary site functions always work. With optional storage denied, Google may still receive limited cookieless consent and measurement pings. Allow measurement to let Google Analytics and non-personalized Google Ads measurement use identifiers. We do not enable ad personalization.
            </p>
            <Link href="/privacy">Read the privacy policy</Link>
          </div>
          <div className="consent-actions">
            <button type="button" className="consent-secondary" onClick={() => saveChoice('necessary')}>Necessary only</button>
            <button type="button" className="consent-primary" onClick={() => saveChoice('measurement')}>Allow measurement</button>
          </div>
        </section>
      ) : null}
      <style jsx global>{`
        .consent-panel {
          position: fixed;
          z-index: 1200;
          left: max(1rem, env(safe-area-inset-left));
          right: max(1rem, env(safe-area-inset-right));
          bottom: max(1rem, env(safe-area-inset-bottom));
          max-width: 920px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 1.5rem;
          align-items: end;
          padding: 1.35rem;
          border: 1px solid rgba(200, 169, 110, 0.42);
          border-radius: 12px;
          background: rgba(14, 12, 9, 0.97);
          color: #d4cfc4;
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.48);
          backdrop-filter: blur(18px);
          font-family: var(--font-jost), 'Jost', sans-serif;
        }
        .consent-kicker { margin: 0 0 0.35rem; color: #c8a96e; font-size: 0.6rem; letter-spacing: 0.24em; text-transform: uppercase; }
        .consent-panel h2 { margin: 0 0 0.45rem; color: #f5f0e8; font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: 1.45rem; font-weight: 400; }
        .consent-panel p { margin: 0; max-width: 650px; font-size: 0.78rem; line-height: 1.65; }
        .consent-panel a { display: inline-block; margin-top: 0.55rem; color: #c8a96e; font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase; }
        .consent-actions { display: flex; gap: 0.65rem; flex-wrap: wrap; justify-content: flex-end; }
        .consent-actions button { min-height: 44px; border-radius: 10px; cursor: pointer; font: 600 0.66rem/1 var(--font-jost), 'Jost', sans-serif; letter-spacing: 0.12em; text-transform: uppercase; }
        .consent-primary { border: 1px solid #c8a96e; background: #c8a96e; color: #0e0c09; padding: 0.8rem 1rem; }
        .consent-secondary { border: 1px solid rgba(245, 240, 232, 0.32); background: transparent; color: #f5f0e8; padding: 0.8rem 1rem; }

        @media (max-width: 720px) {
          .consent-panel { grid-template-columns: 1fr; gap: 1rem; padding: 1rem; }
          .consent-actions { display: grid; grid-template-columns: 1fr 1fr; }
          .consent-actions button { width: 100%; }

        }
      `}</style>
    </>
  );
}

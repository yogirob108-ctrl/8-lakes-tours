"use client";

import { track } from '@vercel/analytics';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export default function LandingCta({ href, label, placement }: { href: string; label: string; placement: string }) {
  function recordClick() {
    track('booking_cta_click', { placement });
    window.gtag?.('event', 'booking_cta_click', {
      event_category: 'booking_funnel',
      placement,
    });
  }

  return <a href={href} onClick={recordClick}>{label}</a>;
}

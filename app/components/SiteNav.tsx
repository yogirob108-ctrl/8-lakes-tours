'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import MobileNavMenu from './MobileNavMenu';

export default function SiteNav() {
  useEffect(() => {
    const nav = document.getElementById('site-nav');
    if (!nav) return;

    const updateNav = () => {
      const currentScrollY = window.scrollY;
      nav.classList.toggle('nav-solid', currentScrollY > 80);
    };

    updateNav();
    window.addEventListener('scroll', updateNav, { passive: true });
    return () => window.removeEventListener('scroll', updateNav);
  }, []);

  return (
    <nav id="site-nav" className="site-nav" aria-label="Site navigation">
      <Link href="/" className="site-nav-logo" aria-label="8 Lakes Tours home">8 Lakes Tours</Link>

      <div className="site-nav-desktop-links" aria-label="Primary navigation">
        <Link href="/gallery">Gallery</Link>
        <Link href="/about">About</Link>
        <Link href="/preparation">Prep</Link>
        <Link href="/faq">FAQ</Link>
        <Link href="/contact">Contact</Link>
        <Link href="/#application" className="site-nav-cta">Reserve</Link>
      </div>

      <div className="site-nav-mobile-actions">
        <MobileNavMenu reserveHref="/#application" />
      </div>
    </nav>
  );
}

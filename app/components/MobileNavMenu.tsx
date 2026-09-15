'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/gallery', label: 'Gallery' },
  { href: '/about', label: 'About' },
  { href: '/preparation', label: 'Prep' },
  { href: '/faq', label: 'FAQ' },
  { href: '/contact', label: 'Contact' },
];

// Phone-only menu. The panel is portalled to <body> because the navs use
// transforms/backdrop-filter, which would otherwise trap a fixed overlay.
export default function MobileNavMenu({ reserveHref }: { reserveHref: string }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onResize = () => {
      if (window.matchMedia('(min-width: 901px)').matches) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      button?.focus();
    };
  }, [open]);

  const close = () => setOpen(false);
  const ReserveLink = reserveHref.startsWith('/') ? Link : 'a';

  return (
    <>
      <ReserveLink href={reserveHref} className="mobile-menu-reserve">Reserve</ReserveLink>
      <button
        ref={buttonRef}
        type="button"
        className="mobile-menu-toggle"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="mobile-menu-panel"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          id="mobile-menu-panel"
          ref={panelRef}
          className="mobile-menu-panel is-open"
          role="dialog"
          aria-modal="true"
          aria-label="Site menu"
        >
          <div className="mobile-menu-top">
            <Link href="/" className="mobile-menu-logo" onClick={close}>8 Lakes Tours</Link>
            <button type="button" className="mobile-menu-close" aria-label="Close menu" onClick={close}>
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
          </div>
          <nav className="mobile-menu-links" aria-label="Site pages">
            {LINKS.map(link => (
              <Link key={link.href} href={link.href} onClick={close}>{link.label}</Link>
            ))}
          </nav>
          <ReserveLink href={reserveHref} className="mobile-menu-panel-reserve" onClick={close}>Reserve your spot</ReserveLink>
        </div>,
        document.body,
      )}
    </>
  );
}

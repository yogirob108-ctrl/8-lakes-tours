import type { Metadata } from 'next';
import Link from 'next/link';
import SiteNav from '../components/SiteNav';
import HeroVideo from '../components/HeroVideo';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Contact 8 Lakes Tours for Mongolian horse trekking booking questions, group dates, payment questions, and pre-trip planning.',
  alternates: { canonical: 'https://www.8lakestours.com/contact' },
  openGraph: {
    title: 'Contact 8 Lakes Tours',
    description: 'Ask about Mongolian horse trekking dates, private groups, payment, insurance, and trip preparation.',
    url: 'https://www.8lakestours.com/contact',
    images: [{ url: '/images/og-8-lakes-horseback-2026.jpg', width: 1200, height: 630, alt: '8 Lakes Tours Mongolia horseback expedition' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Contact 8 Lakes Tours',
    description: 'Ask about Mongolian horse trekking dates, private groups, payment, insurance, and trip preparation.',
    images: ['/images/og-8-lakes-horseback-2026.jpg'],
  },
  robots: { index: true, follow: true },
};

const pageStyle = { background: '#0e0c09', minHeight: '100vh', color: '#d4cfc4', fontFamily: "var(--font-jost), 'Jost', sans-serif", fontWeight: 300 } as const;
const linkStyle = { fontSize: '0.7rem', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c8a96e', textDecoration: 'none' } as const;
const wrapperStyle = { maxWidth: '760px', margin: '0 auto', padding: '5rem 2rem' } as const;
const h2Style = { fontFamily: "var(--font-cormorant), 'Cormorant Garamond', serif", fontSize: '1.35rem', fontWeight: 400, color: '#f5f0e8', marginBottom: '0.6rem' } as const;
const pStyle = { fontSize: '0.95rem', lineHeight: 1.85, color: '#d4cfc4', opacity: 0.86 } as const;
const footerStyle = { borderTop: '1px solid rgba(200,169,110,0.15)', padding: '2rem 4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' } as const;

export default function Page() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    '@id': 'https://www.8lakestours.com/contact#contact-page',
    url: 'https://www.8lakestours.com/contact',
    name: 'Contact 8 Lakes Tours',
    description: 'Contact 8 Lakes Tours for Mongolian horse trekking booking questions, group dates, payment questions, and pre-trip planning.',
    inLanguage: 'en',
    mainEntity: {
      '@type': ['Organization', 'TravelAgency'],
      name: '8 Lakes Tours',
      url: 'https://www.8lakestours.com',
      email: 'info@8lakestours.com',
      sameAs: ['https://www.instagram.com/8lakestours', 'https://www.instagram.com/robzaher108'],
      contactPoint: {
        '@type': 'ContactPoint',
        contactType: 'booking enquiries',
        email: 'info@8lakestours.com',
        availableLanguage: ['en'],
      },
    },
  };

  return (
    <main style={pageStyle}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />
      <style>{`
        .page-hero { position: relative; display: flex; align-items: flex-end; justify-content: center; min-height: 54vh; padding: 8rem 2rem 3rem; text-align: center; overflow: hidden; }
        .page-hero-media { position: absolute; inset: 0; background: #0e0c09 url('/videos/contact-river-hands-poster.jpg?v=3') center 28% / cover no-repeat; }
        .page-hero-video.is-playing { opacity: 1; }
        .page-hero-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 28%; opacity: 0; transition: opacity 1.6s ease; }
        @media (max-width: 900px) { .page-hero-media { background-image: url('/videos/contact-river-hands-poster-mobile.jpg?v=3'); } }
        @media (prefers-reduced-motion: reduce) { .page-hero-video { display: none; } }
        .page-hero-overlay { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 35%, rgba(14,12,9,0) 28%, rgba(14,12,9,0.52) 100%), linear-gradient(to top, rgba(14,12,9,1) 2%, rgba(14,12,9,0.78) 30%, rgba(14,12,9,0.38) 68%, rgba(14,12,9,0.66) 100%); }
        .page-hero-copy { position: relative; z-index: 1; max-width: 820px; }
        .page-hero-copy .page-hero-eyebrow { font-size: 0.65rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c8a96e; margin: 0 0 1rem; }
        .page-hero-copy h1 { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(2.8rem, 8vw, 5rem); font-weight: 300; line-height: 0.98; color: #f5f0e8; margin: 0; }
        .page-hero-copy .page-hero-intro { margin: 1.4rem auto 0; max-width: 660px; font-size: 1rem; line-height: 1.8; color: rgba(212,207,196,0.86); }
        @media (max-width: 900px) { .page-hero { min-height: 46vh; padding: 6rem 1.25rem 2.25rem; } }
      `}</style>
      <header className="page-hero">
        <div className="page-hero-media" role="img" aria-label="Hands moving through the clear water of a mountain river">
          <HeroVideo className="page-hero-video" desktopSrc="/videos/contact-river-hands-loop.mp4?v=3" mobileSrc="/videos/contact-river-hands-loop-mobile.mp4?v=3" />
          <div className="page-hero-overlay" />
        </div>
        <div className="page-hero-copy">
          <p className="page-hero-eyebrow">Contact</p>
          <h1>Contact 8 Lakes Tours</h1>
          <p className="page-hero-intro">For booking questions, private group dates, payment questions, insurance requirements, or Mongolia trip planning, contact 8 Lakes Tours directly.</p>
        </div>
      </header>
      <div style={{...wrapperStyle, paddingTop: '3.5rem'}}>
        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={h2Style}>Email</h2>
          <p style={pStyle}><a href="mailto:info@8lakestours.com" style={{ color: '#c8a96e' }}>info@8lakestours.com</a></p>
        </section>
        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={h2Style}>Instagram</h2>
          <p style={pStyle}><a href="https://www.instagram.com/8lakestours" target="_blank" rel="noopener noreferrer" style={{ color: '#c8a96e' }}>@8lakestours</a></p>
          <p style={{...pStyle, marginTop: '0.8rem'}}>Robert Zaher: <a href="https://www.instagram.com/robzaher108?igsh=OHdvdGp0ZW9ieHFv" target="_blank" rel="noopener noreferrer" style={{ color: '#c8a96e' }}>@robzaher108</a></p>
        </section>
        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={h2Style}>Booking enquiries</h2>
          <p style={pStyle}>The fastest way to start is the booking form on the homepage. It asks for your preferred date, riding experience, dietary restrictions, emergency contact, and any special notes so the team can prepare properly and check fit if anything needs review.</p>
          <p style={{...pStyle, marginTop: '1rem'}}><Link href="/#application" style={{ color: '#c8a96e' }}>Go to booking form →</Link></p>
        </section>
      </div>
      <footer style={footerStyle}>
        <span style={{ fontSize: '0.75rem', color: '#d4cfc4', opacity: 0.4 }}>© 2026 8 Lakes Tours · All rights reserved</span>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          <Link href="/terms" style={{...linkStyle, opacity: 0.75}}>Terms</Link>
          <Link href="/privacy" style={{...linkStyle, opacity: 0.75}}>Privacy</Link>
          <Link href="/llms.txt" style={{...linkStyle, opacity: 0.75}}>LLMs.txt</Link>
        </div>
      </footer>
    </main>
  );
}

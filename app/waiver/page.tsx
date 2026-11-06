import type { Metadata } from 'next';
import SiteNav from '../components/SiteNav';
import WaiverForm from './WaiverForm';
import { WAIVER_CLOSING, WAIVER_SECTIONS, WAIVER_VERSION } from '@/lib/waiver.mjs';

export const metadata: Metadata = {
  title: 'Rider Waiver',
  description: 'Every rider on an 8 Lakes Tours horse trek signs their own liability waiver before the trip.',
  alternates: { canonical: 'https://www.8lakestours.com/waiver' },
  robots: { index: false, follow: false },
};

const pageStyle = { background: '#0e0c09', minHeight: '100vh', color: '#d4cfc4', fontFamily: "var(--font-jost), 'Jost', sans-serif", fontWeight: 300 } as const;

export default async function Page({ searchParams }: { searchParams: Promise<{ ref?: string | string[] }> }) {
  const params = await searchParams;
  const reference = typeof params.ref === 'string' ? params.ref.slice(0, 24) : '';

  return (
    <main style={pageStyle}>
      <SiteNav />
      <style>{`
        .waiver-page { max-width: 720px; margin: 0 auto; padding: 8rem 1.5rem 5rem; }
        .waiver-page .eyebrow { font-size: 0.65rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c8a96e; margin: 0 0 0.8rem; }
        .waiver-page h1 { font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(2.2rem, 7vw, 3.2rem); font-weight: 300; color: #f5f0e8; margin: 0 0 1rem; line-height: 1.05; }
        .waiver-page .intro { font-size: 0.98rem; line-height: 1.8; margin: 0 0 2rem; }
        .waiver-text { border: 1px solid rgba(200,169,110,0.2); border-radius: 4px; padding: 1.2rem 1.4rem; max-height: 420px; overflow-y: auto; font-size: 0.85rem; line-height: 1.8; background: rgba(255,255,255,0.02); }
        .waiver-text h2 { font-size: 0.62rem; letter-spacing: 0.2em; text-transform: uppercase; color: #c8a96e; margin: 1.1rem 0 0.3rem; font-weight: 400; }
        .waiver-text h2:first-child { margin-top: 0; }
        .waiver-text p { margin: 0; }
        .waiver-text .closing { margin-top: 1.1rem; font-style: italic; opacity: 0.75; }
        .waiver-version { font-size: 0.7rem; opacity: 0.5; margin-top: 0.5rem; }
        @media (max-width: 600px) { .waiver-page { padding-top: 6.5rem; } .waiver-text { max-height: 360px; padding: 1rem; } }
      `}</style>
      <div className="waiver-page">
        <p className="eyebrow">Before you ride</p>
        <h1>Rider waiver</h1>
        <p className="intro">Every rider signs their own waiver before the trip. It takes about two minutes. Riders aged 16 or 17 need a parent or legal guardian to sign for them. Please read the waiver, then fill in the form below.</p>
        <div className="waiver-text" role="region" aria-label="Liability waiver text" tabIndex={0}>
          {WAIVER_SECTIONS.map(section => (
            <div key={section.title}>
              <h2>{section.title}</h2>
              <p>{section.body}</p>
            </div>
          ))}
          <p className="closing">{WAIVER_CLOSING}</p>
        </div>
        <p className="waiver-version">Waiver version {WAIVER_VERSION}</p>
        <WaiverForm initialReference={reference} />
      </div>
    </main>
  );
}

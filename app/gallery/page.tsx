import type { Metadata } from 'next';
import Link from 'next/link';
import GalleryClient from './GalleryClient';
import { GALLERY_IMAGES } from './gallery-data';
import SiteNav from '../components/SiteNav';
import HeroVideo from '../components/HeroVideo';

export const metadata: Metadata = {
  title: 'Photo Gallery',
  description: 'A full photo gallery from 8 Lakes Tours: horses, host families, gers, mountain valleys, river crossings, and the Eight Lakes region of Mongolia.',
  alternates: { canonical: 'https://www.8lakestours.com/gallery' },
  openGraph: {
    title: '8 Lakes Tours Photo Gallery',
    description: 'Horses, host families, gers, mountain valleys, river crossings, and the Eight Lakes region of Mongolia.',
    url: 'https://www.8lakestours.com/gallery',
    images: [{ url: '/images/og-8-lakes-gallery-2026.jpg', width: 1200, height: 630, alt: 'Mongolia horse trekking photo gallery — 8 Lakes Tours' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '8 Lakes Tours Photo Gallery',
    description: 'Horses, host families, gers, mountain valleys, river crossings, and the Eight Lakes region of Mongolia.',
    images: ['/images/og-8-lakes-gallery-2026.jpg'],
  },
  robots: { index: true, follow: true },
};

export default function GalleryPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ImageGallery',
    '@id': 'https://www.8lakestours.com/gallery#image-gallery',
    url: 'https://www.8lakestours.com/gallery',
    name: '8 Lakes Tours Photo Gallery',
    description: 'A full photo gallery from 8 Lakes Tours: horses, host families, gers, mountain valleys, river crossings, and the Eight Lakes region of Mongolia.',
    inLanguage: 'en',
    image: GALLERY_IMAGES.slice(0, 12).map(image => ({
      '@type': 'ImageObject',
      url: `https://www.8lakestours.com${image.src}`,
      caption: image.alt,
      width: image.width,
      height: image.height,
    })),
  };

  return (
    <main className="gallery-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <header className="gallery-hero">
        <div className="gallery-hero-media" role="img" aria-label="Horses drinking at a river with clouds reflected on the water">
          <HeroVideo className="gallery-hero-video" desktopSrc="/videos/gallery-river-horses-loop.mp4?v=2" mobileSrc="/videos/gallery-river-horses-loop-mobile.mp4?v=2" />
          <div className="gallery-hero-overlay" />
        </div>
        <div className="gallery-hero-copy">
          <h1>Photo Gallery</h1>
          <p>
            A deeper look at the world around the expedition: the vastness and rawness of the steppe,
            and the nomadic families who have adapted to its conditions over millennia.
          </p>
        </div>
      </header>

      <GalleryClient images={GALLERY_IMAGES} />

      <footer className="gallery-footer">
        <span>© 2026 8 Lakes Tours</span>
        <Link href="/#book">Reserve a spot</Link>
      </footer>

      <style>{`
        .gallery-page { min-height: 100vh; background: #0e0c09; color: #d4cfc4; font-family: var(--font-jost), 'Jost', sans-serif; font-weight: 300; }
        .gallery-footer a { color: #c8a96e; text-decoration: none; text-transform: uppercase; letter-spacing: 0.18em; font-size: 0.68rem; }
        .gallery-hero { position: relative; display: flex; align-items: flex-end; justify-content: center; min-height: 62vh; padding: 8rem 2rem 3.5rem; text-align: center; overflow: hidden; }
        .gallery-hero-media { position: absolute; inset: 0; background: #0e0c09 url('/videos/gallery-river-horses-poster.jpg?v=2') center / cover no-repeat; }
        .gallery-hero-video.is-playing { opacity: 1; }
        .gallery-hero-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 1.6s ease; }
        @media (max-width: 900px) { .gallery-hero-media { background-image: url('/videos/gallery-river-horses-poster-mobile.jpg?v=2'); } }
        @media (prefers-reduced-motion: reduce) { .gallery-hero-video { display: none; } }
        .gallery-hero-overlay { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 35%, rgba(14,12,9,0) 30%, rgba(14,12,9,0.5) 100%), linear-gradient(to top, rgba(14,12,9,1) 2%, rgba(14,12,9,0.72) 32%, rgba(14,12,9,0.3) 70%, rgba(14,12,9,0.62) 100%); }
        .gallery-hero-copy { position: relative; z-index: 1; max-width: 980px; }
        .eyebrow { margin-bottom: 1rem; color: #c8a96e; text-transform: uppercase; letter-spacing: 0.3em; font-size: 0.68rem; }
        .gallery-hero-copy h1 { margin: 0; color: #f5f0e8; font-family: var(--font-cormorant), 'Cormorant Garamond', serif; font-size: clamp(3.3rem, 9vw, 7rem); line-height: 0.9; font-weight: 300; }
        .gallery-hero-copy p:not(.eyebrow) { max-width: 680px; margin: 1.5rem auto 0; font-size: 1rem; line-height: 1.8; color: rgba(212,207,196,0.82); }
        .gallery-grid { padding: 3px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; background: #0f0f0d; }
        .gallery-card { all: unset; position: relative; display: block; overflow: hidden; border-radius: 4px; background: #17130e; cursor: zoom-in; min-height: 260px; }
        .gallery-card.portrait { grid-row: span 2; }
        .gallery-card img { display: block; width: 100%; height: 100%; min-height: inherit; object-fit: cover; transition: transform 0.5s ease, filter 0.5s ease; }
        .gallery-card:hover img { transform: scale(1.035); filter: brightness(1.08); }

        .gallery-lightbox { position: fixed; inset: 0; z-index: 1000; background: rgba(14,12,9,0.96); display: flex; align-items: center; justify-content: center; padding: 1.5rem; cursor: zoom-out; }
        .lightbox-frame { width: min(96vw, 1800px); height: min(86vh, 1100px); display: flex; align-items: center; justify-content: center; }
        .lightbox-frame img { width: 100%; height: 100%; object-fit: contain; }
        .lightbox-close, .lightbox-nav { position: fixed; z-index: 1001; border: 1px solid rgba(245,240,232,0.35); background: rgba(14,12,9,0.82); color: #f5f0e8; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .lightbox-close { top: calc(1rem + env(safe-area-inset-top)); right: calc(1rem + env(safe-area-inset-right)); width: 3rem; height: 3rem; border-radius: 999px; font-size: 1.4rem; }
        .lightbox-nav { top: 50%; transform: translateY(-50%); width: 3rem; height: 3rem; border-radius: 999px; font-size: 1.8rem; }
        .lightbox-prev { left: 1rem; }
        .lightbox-next { right: 1rem; }

        .gallery-footer { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: 2rem 3rem; border-top: 1px solid rgba(200,169,110,0.15); color: rgba(212,207,196,0.5); font-size: 0.75rem; }
        @media (max-width: 1100px) { .gallery-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 700px) {
          .gallery-hero { min-height: 52vh; padding: 6rem 1.25rem 2.5rem; }
          .gallery-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .gallery-card { min-height: 190px; }
          .gallery-card.portrait { min-height: 300px; }

          .lightbox-nav { width: 2.7rem; height: 2.7rem; }
          .lightbox-prev { left: 0.5rem; }
          .lightbox-next { right: 0.5rem; }
          .lightbox-close { width: 3.3rem; height: 3.3rem; }
          .gallery-footer { padding: 1.5rem; }
        }
      `}</style>
    </main>
  );
}

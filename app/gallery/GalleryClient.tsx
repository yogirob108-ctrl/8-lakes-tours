'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';
import type { GalleryImage } from './gallery-data';

export default function GalleryClient({ images }: { images: GalleryImage[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const visibleImages = images;
  const lightboxImage = lightboxIndex === null ? null : visibleImages[lightboxIndex];

  const openLightbox = useCallback((index: number) => setLightboxIndex(index), []);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const showPrevious = useCallback(() => {
    setLightboxIndex(current => current === null ? current : (current + visibleImages.length - 1) % visibleImages.length);
  }, [visibleImages.length]);
  const showNext = useCallback(() => {
    setLightboxIndex(current => current === null ? current : (current + 1) % visibleImages.length);
  }, [visibleImages.length]);

  useEffect(() => {
    if (lightboxIndex === null || typeof window === 'undefined') return;
    document.documentElement.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLightbox();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showPrevious();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        showNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const preloadIndexes = [
      lightboxIndex,
      (lightboxIndex + 1) % visibleImages.length,
      (lightboxIndex + visibleImages.length - 1) % visibleImages.length,
      (lightboxIndex + 2) % visibleImages.length,
    ];

    preloadIndexes.forEach(index => {
      const src = visibleImages[index]?.src;
      if (!src) return;
      const image = new window.Image();
      image.decoding = 'async';
      image.src = src;
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.documentElement.style.overflow = '';
    };
  }, [closeLightbox, lightboxIndex, showNext, showPrevious, visibleImages]);

  return (
    <>
      <div className="gallery-grid">
        {visibleImages.map((image, index) => (
          <button
            type="button"
            className={`gallery-card ${image.orientation}`}
            key={image.src}
            onClick={() => openLightbox(index)}
            aria-label={`Open image: ${image.alt}`}
          >
            <Image
              src={image.src}
              alt={image.alt}
              width={image.width}
              height={image.height}
              quality={72}
              sizes="(max-width: 700px) 50vw, (max-width: 1100px) 33vw, 25vw"
            />
          </button>
        ))}
      </div>

      {lightboxImage && (
        <div className="gallery-lightbox" role="dialog" aria-modal="true" aria-label={lightboxImage.alt} onClick={closeLightbox}>
          <button type="button" className="lightbox-close" onClick={event => { event.stopPropagation(); closeLightbox(); }} aria-label="Close image">×</button>
          <button type="button" className="lightbox-nav lightbox-prev" onClick={event => { event.stopPropagation(); showPrevious(); }} aria-label="Previous image">‹</button>
          <div className="lightbox-frame" onClick={event => event.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element -- Gallery lightbox uses direct local originals with adjacent preloading for instant browsing. */}
            <img src={lightboxImage.src} alt={lightboxImage.alt} decoding="async" />
          </div>
          <button type="button" className="lightbox-nav lightbox-next" onClick={event => { event.stopPropagation(); showNext(); }} aria-label="Next image">›</button>
        </div>
      )}
    </>
  );
}

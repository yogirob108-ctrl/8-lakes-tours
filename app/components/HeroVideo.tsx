'use client';

import { useEffect, useRef } from 'react';

// Hero background video. The poster still is painted by CSS on the wrapper, so
// the video itself downloads nothing until the page has finished loading, and
// it fades in only once it is actually playing. Skipped entirely for
// reduced-motion and data-saver visitors.
export default function HeroVideo({ className, desktopSrc, mobileSrc, label }: {
  className: string;
  desktopSrc: string;
  mobileSrc: string;
  label?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || connection?.saveData) return;
    const start = () => {
      video.preload = 'auto';
      video.load();
      video.play().catch(() => {});
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => window.removeEventListener('load', start);
  }, []);

  return (
    <video
      ref={videoRef}
      className={className}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      aria-label={label}
      onPlaying={event => event.currentTarget.classList.add('is-playing')}
    >
      <source src={mobileSrc} type="video/mp4" media="(max-width: 900px)" />
      <source src={desktopSrc} type="video/mp4" />
    </video>
  );
}

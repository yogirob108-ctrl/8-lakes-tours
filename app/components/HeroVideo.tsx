'use client';

import { useEffect, useRef } from 'react';

// Hero background video. The poster still is painted by CSS on the wrapper, so
// the video itself downloads nothing until the page has finished loading, and
// it fades in only once it is actually playing. One responsive video element
// means the browser selects exactly one source instead of downloading duplicate
// passes of the same clip on constrained connections.
export default function HeroVideo({ className, desktopSrc, mobileSrc, label, dissolveAtLoop = false, fadeInSeconds = 0, loopFadeSeconds = 1.2 }: {
  className: string;
  desktopSrc: string;
  mobileSrc: string;
  label?: string;
  // Crossfades the clip into itself at the loop instead of cutting. This needs
  // two elements: a single video can only dissolve to whatever sits behind it,
  // which is the static poster, so the picture freezes mid-seam. Worse, the
  // `loop` attribute's seek back to zero stalls the decoder for a beat, and the
  // frozen frame is exactly what a fade leaves on screen. Two elements let the
  // incoming pass be already playing and decoded before the outgoing one goes,
  // so both sides of the seam are moving.
  dissolveAtLoop?: boolean;
  // With dissolveAtLoop the opacity is driven frame by frame, so a CSS
  // transition cannot soften the first appearance over the poster. This eases
  // the whole layer in over the given seconds instead; 0 keeps the old snap.
  fadeInSeconds?: number;
  // Length of the loop crossfade; slow footage reads better with a longer one.
  loopFadeSeconds?: number;
}) {
  const primaryRef = useRef<HTMLVideoElement | null>(null);


  useEffect(() => {
    const primary = primaryRef.current;
    if (!primary) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || connection?.saveData) return;
    const start = () => {
      primary.preload = 'auto';
      primary.load();
      primary.play().catch(() => {});
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => window.removeEventListener('load', start);
  }, []);


  const sources = (
    <>
      <source src={mobileSrc} type="video/mp4" media="(max-width: 900px)" />
      <source src={desktopSrc} type="video/mp4" />
    </>
  );

  // Keep the historical props temporarily so every route can migrate without a
  // visual API break. Native looping trades the nonessential crossfade for one
  // request and one decoder.
  void dissolveAtLoop;
  void fadeInSeconds;
  void loopFadeSeconds;
  return (
    <video
      ref={primaryRef}
      className={className}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      aria-label={label}
      onPlaying={event => event.currentTarget.classList.add('is-playing')}
    >
      {sources}
    </video>
  );
}

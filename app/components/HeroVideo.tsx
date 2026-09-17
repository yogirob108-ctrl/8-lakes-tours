'use client';

import { useEffect, useRef } from 'react';

// Hero background video. The poster still is painted by CSS on the wrapper, so
// the video itself downloads nothing until the page has finished loading, and
// it fades in only once it is actually playing. Skipped entirely for
// reduced-motion and data-saver visitors.
export default function HeroVideo({ className, desktopSrc, mobileSrc, label, dissolveAtLoop = false }: {
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
}) {
  const primaryRef = useRef<HTMLVideoElement | null>(null);
  const secondaryRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const primary = primaryRef.current;
    if (!primary) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || connection?.saveData) return;
    const start = () => {
      for (const video of [primary, secondaryRef.current]) {
        if (!video) continue;
        video.preload = 'auto';
        video.load();
      }
      // Only the primary starts now; the second pass is cued by the crossfade.
      primary.play().catch(() => {});
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => window.removeEventListener('load', start);
  }, []);

  useEffect(() => {
    const a = primaryRef.current;
    const b = secondaryRef.current;
    if (!dissolveAtLoop || !a || !b) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const FADE_SECONDS = 1.2;
    // Eased rather than linear so the outgoing pass leaves full opacity gently
    // instead of stepping off it.
    const smoothstep = (t: number) => t * t * (3 - 2 * t);
    const clamp = (t: number) => Math.min(1, Math.max(0, t));

    let front = a;
    let back = b;
    let frame = 0;
    let cued = false;

    const handOver = () => {
      front.pause();
      front.currentTime = 0;
      front.style.opacity = '0';
      back.style.opacity = '1';
      [front, back] = [back, front];
      cued = false;
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const { duration, currentTime } = front;
      if (!Number.isFinite(duration) || duration <= FADE_SECONDS * 2) return;
      const remaining = duration - currentTime;
      if (remaining > FADE_SECONDS) {
        front.style.opacity = '1';
        return;
      }
      // Start the incoming pass a full fade before the outgoing one ends, so it
      // is decoding and moving by the time any of it is visible.
      if (!cued) {
        cued = true;
        back.currentTime = 0;
        back.play().catch(() => {});
      }
      const eased = smoothstep(clamp(1 - remaining / FADE_SECONDS));
      front.style.opacity = String(1 - eased);
      back.style.opacity = String(eased);
      // `ended` can be late by a frame or two; swap as soon as the tail is spent
      // so the finished element never lingers at a visible opacity.
      if (front.ended || remaining <= 0.02) handOver();
    };

    const onPlaying = () => {
      front.style.opacity = '1';
      back.style.opacity = '0';
      if (!frame) frame = requestAnimationFrame(tick);
    };

    a.addEventListener('playing', onPlaying, { once: true });
    if (!a.paused) onPlaying();
    return () => {
      cancelAnimationFrame(frame);
      frame = 0;
      a.removeEventListener('playing', onPlaying);
      a.style.opacity = '';
      b.style.opacity = '';
    };
  }, [dissolveAtLoop]);

  const sources = (
    <>
      <source src={mobileSrc} type="video/mp4" media="(max-width: 900px)" />
      <source src={desktopSrc} type="video/mp4" />
    </>
  );

  if (!dissolveAtLoop) {
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

  // Looping is handed back and forth between the two elements rather than left
  // to the `loop` attribute, whose seek is the stall this exists to avoid.
  return (
    <>
      <video
        ref={primaryRef}
        className={className}
        muted
        playsInline
        preload="none"
        aria-hidden="true"
        aria-label={label}
        onPlaying={event => event.currentTarget.classList.add('is-playing')}
      >
        {sources}
      </video>
      <video
        ref={secondaryRef}
        className={className}
        muted
        playsInline
        preload="none"
        aria-hidden="true"
        style={{ opacity: 0 }}
      >
        {sources}
      </video>
    </>
  );
}

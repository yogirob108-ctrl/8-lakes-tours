'use client';

import { useEffect, useRef } from 'react';

// Hero background video. The poster still is painted by CSS on the wrapper, so
// the video itself downloads nothing until the page has finished loading, and
// it fades in only once it is actually playing. For a seamless loop, the second
// decoder stays idle until shortly before the seam; every video element uses the
// same media query sources, so a phone never selects the desktop resource.
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
  const secondaryRef = useRef<HTMLVideoElement | null>(null);

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

  useEffect(() => {
    const a = primaryRef.current;
    const b = secondaryRef.current;
    if (!dissolveAtLoop || !a || !b) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const FADE_SECONDS = loopFadeSeconds;
    // Give the incoming element a short decode runway without requesting it at
    // initial page load. This keeps LCP work to one video and preserves the
    // moving-to-moving handoff that avoids a visible loop seam.
    const PREWARM_SECONDS = Math.max(FADE_SECONDS + 2, FADE_SECONDS * 2);
    const smoothstep = (t: number) => t * t * (3 - 2 * t);
    const clamp = (t: number) => Math.min(1, Math.max(0, t));

    let front = a;
    let back = b;
    let frame = 0;
    let prepared = false;
    let cued = false;
    let startedAt = 0;
    const arrival = () => fadeInSeconds > 0 && startedAt
      ? smoothstep(clamp((performance.now() - startedAt) / (fadeInSeconds * 1000)))
      : 1;
    const show = (video: HTMLVideoElement, value: number) => { video.style.opacity = String(value * arrival()); };

    const handOver = () => {
      front.pause();
      front.currentTime = 0;
      front.style.opacity = '0';
      show(back, 1);
      [front, back] = [back, front];
      prepared = false;
      cued = false;
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const { duration, currentTime } = front;
      if (!Number.isFinite(duration) || duration <= PREWARM_SECONDS) return;
      const remaining = duration - currentTime;
      if (remaining > PREWARM_SECONDS) {
        show(front, 1);
        return;
      }
      if (!prepared) {
        prepared = true;
        back.preload = 'auto';
        back.load();
      }
      if (remaining > FADE_SECONDS) {
        show(front, 1);
        return;
      }
      if (!cued) {
        cued = true;
        back.currentTime = 0;
        back.play().catch(() => {});
      }
      const eased = smoothstep(clamp(1 - remaining / FADE_SECONDS));
      show(front, 1 - eased);
      show(back, eased);
      if (front.ended || remaining <= 0.02) handOver();
    };

    const onPlaying = () => {
      startedAt = performance.now();
      show(front, 1);
      back.style.opacity = '0';
      if (!frame) frame = requestAnimationFrame(tick);
    };

    a.addEventListener('playing', onPlaying, { once: true });
    if (!a.paused) onPlaying();
    return () => {
      cancelAnimationFrame(frame);
      a.removeEventListener('playing', onPlaying);
      a.style.opacity = '';
      b.style.opacity = '';
    };
  }, [dissolveAtLoop, fadeInSeconds, loopFadeSeconds]);

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

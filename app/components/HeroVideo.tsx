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
  // Fades the clip out over the last moment and back in after it restarts, so
  // the cut from the final frame to the first one never snaps. The page styles
  // supply the timing through .is-armed / .is-dissolving.
  dissolveAtLoop?: boolean;
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !dissolveAtLoop) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const FADE_SECONDS = 1.1;
    // `timeupdate` only fires a few times a second, so a CSS transition started
    // from it lands late and by a different amount each lap — the seam stutters.
    // Drive opacity per frame instead: the ramp is tied to the clip's own clock,
    // so it reaches zero exactly on the last frame and comes back symmetrically.
    // Smoothstep rather than a straight line, so it eases out of full opacity
    // and into it rather than starting and stopping abruptly.
    const smoothstep = (t: number) => t * t * (3 - 2 * t);
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const { duration, currentTime } = video;
      if (!Number.isFinite(duration) || duration <= FADE_SECONDS * 2) return;
      const remaining = duration - currentTime;
      const ramp = remaining < FADE_SECONDS ? remaining / FADE_SECONDS
        : currentTime < FADE_SECONDS ? currentTime / FADE_SECONDS
        : 1;
      video.style.opacity = String(smoothstep(Math.min(1, Math.max(0, ramp))));
    };
    const start = () => { if (!frame) frame = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; };
    video.addEventListener('playing', start);
    video.addEventListener('pause', stop);
    if (!video.paused) start();
    return () => {
      stop();
      video.removeEventListener('playing', start);
      video.removeEventListener('pause', stop);
      video.style.opacity = '';
    };
  }, [dissolveAtLoop]);

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

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
    const FADE_SECONDS = 0.9;
    // Arm the transition only once playback has begun, so the poster-to-video
    // swap stays instant and the fade belongs to the loop alone.
    const arm = () => video.classList.add('is-armed');
    const onTimeUpdate = () => {
      const { duration, currentTime } = video;
      if (!Number.isFinite(duration) || duration <= FADE_SECONDS * 2) return;
      video.classList.toggle('is-dissolving', duration - currentTime <= FADE_SECONDS);
    };
    // A seek back to the top is the loop itself; clear the fade immediately so
    // the clip is already on its way back in as the first frame paints.
    const onSeeked = () => { if (video.currentTime < FADE_SECONDS) video.classList.remove('is-dissolving'); };
    video.addEventListener('playing', arm, { once: true });
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onSeeked);
    return () => {
      video.removeEventListener('playing', arm);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeked', onSeeked);
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

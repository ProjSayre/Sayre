import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../demo/canvas/useCamera";

const HERO_DURATION_WITH_LOAD_BUFFER_MS = 13_000;

type HeroAnimeVideoProps = {
  onComplete?: () => void;
};

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function HeroAnimeVideo({ onComplete }: HeroAnimeVideoProps): JSX.Element {
  const callbackRef = useRef(onComplete);
  const completedRef = useRef(false);
  const [reducedMotion] = useState(prefersReducedMotion);
  const [mountVideo, setMountVideo] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [holdFinalStill, setHoldFinalStill] = useState(reducedMotion);
  const [stopVideo, setStopVideo] = useState(reducedMotion);

  useEffect(() => {
    callbackRef.current = onComplete;
  }, [onComplete]);

  const complete = useCallback((): void => {
    if (completedRef.current) return;
    completedRef.current = true;
    callbackRef.current?.();
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      complete();
      return;
    }

    const idleWindow = window as IdleWindow;
    let timeoutHandle = 0;
    let idleHandle = 0;

    if (idleWindow.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(() => setMountVideo(true), { timeout: 700 });
    } else {
      timeoutHandle = window.setTimeout(() => setMountVideo(true), 120);
    }

    return () => {
      if (idleHandle) idleWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle) window.clearTimeout(timeoutHandle);
    };
  }, [complete, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return;
    const timeoutHandle = window.setTimeout(() => {
      setHoldFinalStill(true);
      setStopVideo(true);
      complete();
    }, HERO_DURATION_WITH_LOAD_BUFFER_MS);
    return () => window.clearTimeout(timeoutHandle);
  }, [complete, reducedMotion]);

  useEffect(() => {
    if (!videoPlaying) return;
    const timeoutHandle = window.setTimeout(() => setHoldFinalStill(true), 250);
    return () => window.clearTimeout(timeoutHandle);
  }, [videoPlaying]);

  const showFinalFallback = useCallback((): void => {
    setHoldFinalStill(true);
    setStopVideo(true);
    complete();
  }, [complete]);

  const desktopStill = holdFinalStill
    ? "/media/hero-anime-final.webp"
    : "/media/hero-anime-start.webp";
  const mobileStill = holdFinalStill
    ? "/media/hero-anime-final-mobile.webp"
    : "/media/hero-anime-start-mobile.webp";

  return (
    <div className="v2-hero__anime" aria-hidden="true">
      <picture className="v2-hero__anime-still">
        <source media="(max-width: 720px)" srcSet={mobileStill} />
        <img
          src={desktopStill}
          alt=""
          decoding="async"
          draggable="false"
        />
      </picture>

      {mountVideo && !stopVideo && (
        <video
          className={videoPlaying ? "v2-hero__anime-video is-playing" : "v2-hero__anime-video"}
          autoPlay
          muted
          playsInline
          preload="metadata"
          poster="/media/hero-anime-start.webp"
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          onPlaying={() => setVideoPlaying(true)}
          onEnded={() => {
            setHoldFinalStill(true);
            complete();
          }}
          onError={(event) => {
            // React surfaces child <source> errors through this handler. Only
            // fail over once the video element itself has exhausted its list.
            if (event.target === event.currentTarget) showFinalFallback();
          }}
        >
          <source media="(max-width: 720px)" src="/media/hero-anime-mobile.mp4" type="video/mp4" />
          <source media="(max-width: 720px)" src="/media/hero-anime-mobile.webm" type="video/webm" />
          <source src="/media/hero-anime.mp4" type="video/mp4" />
          <source src="/media/hero-anime.webm" type="video/webm" />
        </video>
      )}
    </div>
  );
}

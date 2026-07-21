import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../demo/canvas/useCamera";

const HERO_START_TIMEOUT_MS = 4_000;
const HERO_STALL_TIMEOUT_MS = 2_500;
const HERO_PLAYBACK_TIMEOUT_MS = 13_000;

type HeroAnimeVideoProps = {
  onComplete?: () => void;
};

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function HeroAnimeVideo({ onComplete }: HeroAnimeVideoProps): JSX.Element {
  const callbackRef = useRef(onComplete);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const finishedRef = useRef(false);
  const startedRef = useRef(false);
  const startupTimerRef = useRef<number | null>(null);
  const stallTimerRef = useRef<number | null>(null);
  const playbackTimerRef = useRef<number | null>(null);
  const [reducedMotion] = useState(prefersReducedMotion);
  const [mountVideo, setMountVideo] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [holdFinalStill, setHoldFinalStill] = useState(reducedMotion);
  const [stopVideo, setStopVideo] = useState(reducedMotion);

  useEffect(() => {
    callbackRef.current = onComplete;
  }, [onComplete]);

  const clearTimer = useCallback((timerRef: { current: number | null }): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearPlaybackTimers = useCallback((): void => {
    clearTimer(startupTimerRef);
    clearTimer(stallTimerRef);
    clearTimer(playbackTimerRef);
  }, [clearTimer]);

  const finishWithStill = useCallback((): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    clearPlaybackTimers();
    setVideoPlaying(false);
    setHoldFinalStill(true);
    setStopVideo(true);
    callbackRef.current?.();
  }, [clearPlaybackTimers]);

  useEffect(() => {
    if (reducedMotion) {
      finishWithStill();
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
  }, [finishWithStill, reducedMotion]);

  useEffect(() => {
    if (reducedMotion || !mountVideo || stopVideo || finishedRef.current) return;
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    video.defaultMuted = true;
    video.muted = true;
    startupTimerRef.current = window.setTimeout(() => {
      if (!disposed) finishWithStill();
    }, HERO_START_TIMEOUT_MS);

    try {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        void playPromise.catch(() => {
          if (!disposed) finishWithStill();
        });
      }
    } catch {
      finishWithStill();
    }

    return () => {
      disposed = true;
      clearTimer(startupTimerRef);
    };
  }, [clearTimer, finishWithStill, mountVideo, reducedMotion, stopVideo]);

  useEffect(() => {
    if (!videoPlaying) return;
    const timeoutHandle = window.setTimeout(() => setHoldFinalStill(true), 250);
    return () => window.clearTimeout(timeoutHandle);
  }, [videoPlaying]);

  useEffect(() => {
    if (!mountVideo || stopVideo) return;
    const handleVisibilityChange = (): void => {
      const video = videoRef.current;
      if (
        document.visibilityState === "visible" &&
        startedRef.current &&
        video?.paused &&
        !video.ended
      ) {
        finishWithStill();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [finishWithStill, mountVideo, stopVideo]);

  useEffect(() => () => clearPlaybackTimers(), [clearPlaybackTimers]);

  const setVideoNode = useCallback((video: HTMLVideoElement | null): void => {
    videoRef.current = video;
    if (!video) return;
    // defaultMuted reflects the content attribute that older WebKit versions
    // inspect before deciding whether a scripted play is allowed.
    video.defaultMuted = true;
    video.muted = true;
  }, []);

  const handlePlaying = useCallback((): void => {
    if (finishedRef.current) return;
    clearTimer(startupTimerRef);
    clearTimer(stallTimerRef);
    setVideoPlaying(true);
    if (startedRef.current) return;
    startedRef.current = true;
    playbackTimerRef.current = window.setTimeout(finishWithStill, HERO_PLAYBACK_TIMEOUT_MS);
  }, [clearTimer, finishWithStill]);

  const armStallFallback = useCallback((): void => {
    if (finishedRef.current || !startedRef.current || stallTimerRef.current !== null) return;
    stallTimerRef.current = window.setTimeout(finishWithStill, HERO_STALL_TIMEOUT_MS);
  }, [finishWithStill]);

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
          ref={setVideoNode}
          className={videoPlaying ? "v2-hero__anime-video is-playing" : "v2-hero__anime-video"}
          muted
          playsInline
          preload="metadata"
          controls={false}
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          onPlaying={handlePlaying}
          onWaiting={armStallFallback}
          onStalled={armStallFallback}
          onPause={(event) => {
            if (!event.currentTarget.ended) finishWithStill();
          }}
          onEnded={finishWithStill}
          onAbort={finishWithStill}
          onError={(event) => {
            // React surfaces child <source> errors through this handler. Only
            // fail over once the video element itself has exhausted its list.
            if (event.target === event.currentTarget) finishWithStill();
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

import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Bounds } from "./layout";
import type { ZoomStore } from "../state";

const MIN_K = 0.4;
const MAX_K = 2.5;
const FIT_PAD = 40;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Cam {
  x: number;
  y: number;
  k: number;
}

export interface CameraApi {
  cam: Cam;
  transform: string;
  size: { w: number; h: number };
  fit: (animate?: boolean) => void;
  flyTo: (wx: number, wy: number, opts?: { duration?: number; k?: number }) => void;
  zoomAt: (factor: number) => void;
  screenFromWorld: (wx: number, wy: number) => { x: number; y: number };
  inView: (wx: number, wy: number, margin?: number) => boolean;
  shouldIgnoreClick: () => boolean;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useCamera(opts: {
  svgRef: RefObject<SVGSVGElement | null>;
  bounds: Bounds | null;
  fitKey: string;
  interactive: boolean;
  zoomStore?: ZoomStore | null;
  onUserInteract?: () => void;
}): CameraApi {
  const { svgRef, interactive } = opts;
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, k: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;

  const boundsRef = useRef(opts.bounds);
  boundsRef.current = opts.bounds;

  const sizeRef = useRef({ w: 0, h: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const draggedRef = useRef(false);
  const ignoreClickRef = useRef(false);
  const userMovedRef = useRef(false);
  const fittedOnceRef = useRef(false);

  const zoomStoreRef = useRef(opts.zoomStore);
  zoomStoreRef.current = opts.zoomStore;
  const onUserInteractRef = useRef(opts.onUserInteract);
  onUserInteractRef.current = opts.onUserInteract;

  const apply = (c: Cam): void => {
    camRef.current = c;
    setCam(c);
    zoomStoreRef.current?.set(c.k);
  };

  const stopAnim = (): void => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  const animateTo = (to: Cam, duration: number): void => {
    stopAnim();
    if (duration <= 0 || prefersReducedMotion()) {
      apply(to);
      return;
    }
    const from = { ...camRef.current };
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      const e = easeOutCubic(t);
      apply({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      });
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else rafRef.current = 0;
    };
    rafRef.current = requestAnimationFrame(step);
  };

  const fitCam = (): Cam | null => {
    const b = boundsRef.current;
    const { w, h } = sizeRef.current;
    if (!b || w === 0 || h === 0 || !isFinite(b.minX)) return null;
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const k = Math.max(MIN_K, Math.min((w - FIT_PAD * 2) / bw, (h - FIT_PAD * 2) / bh, 1));
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return { x: w / 2 - k * cx, y: h / 2 - k * cy, k };
  };

  const fit = (animate = false): void => {
    const target = fitCam();
    if (!target) return;
    userMovedRef.current = false;
    animateTo(target, animate ? 300 : 0);
  };

  const fitRef = useRef(fit);
  fitRef.current = fit;

  // size tracking + initial/responsive fit
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
      setSize((s) => (s.w === rect.width && s.h === rect.height ? s : { w: rect.width, h: rect.height }));
      if (!userMovedRef.current) fitRef.current(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fit on mount / fitKey change (tab entry, font settle, scope change)
  useEffect(() => {
    const animate = fittedOnceRef.current && !prefersReducedMotion();
    fitRef.current(animate);
    fittedOnceRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.fitKey, opts.bounds === null]);

  // interaction listeners
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !interactive) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStart: { dist: number; k: number; mid: { x: number; y: number }; cam: Cam } | null = null;
    let panStart: { px: number; py: number; cam: Cam } | null = null;
    let movedPx = 0;

    const local = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      stopAnim();
      userMovedRef.current = true;
      onUserInteractRef.current?.();
      const { x: sx, y: sy } = local(e);
      const c = camRef.current;
      const k2 = Math.max(MIN_K, Math.min(MAX_K, c.k * Math.exp(-e.deltaY * 0.0022)));
      if (k2 === c.k) return;
      apply({
        k: k2,
        x: sx - ((sx - c.x) * k2) / c.k,
        y: sy - ((sy - c.y) * k2) / c.k,
      });
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      stopAnim();
      // NOTE: do NOT setPointerCapture here — capture retargets the eventual
      // `click` to the svg, which silently kills node clicks. Capture is taken
      // only once a drag/pinch actually starts.
      pointers.set(e.pointerId, local(e));
      movedPx = 0;
      draggedRef.current = false;
      if (pointers.size === 1) {
        const p = local(e);
        panStart = { px: p.x, py: p.y, cam: { ...camRef.current } };
        pinchStart = null;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          k: camRef.current.k,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          cam: { ...camRef.current },
        };
        panStart = null;
        for (const id of pointers.keys()) {
          try {
            el.setPointerCapture(id);
          } catch {
            /* pointer may already be gone */
          }
        }
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const k2 = Math.max(MIN_K, Math.min(MAX_K, (pinchStart.k * dist) / Math.max(1, pinchStart.dist)));
        const worldMid = {
          x: (pinchStart.mid.x - pinchStart.cam.x) / pinchStart.cam.k,
          y: (pinchStart.mid.y - pinchStart.cam.y) / pinchStart.cam.k,
        };
        userMovedRef.current = true;
        onUserInteractRef.current?.();
        apply({ k: k2, x: mid.x - worldMid.x * k2, y: mid.y - worldMid.y * k2 });
      } else if (pointers.size === 1 && panStart) {
        const p = local(e);
        const dx = p.x - panStart.px;
        const dy = p.y - panStart.py;
        movedPx = Math.max(movedPx, Math.hypot(dx, dy));
        if (movedPx > 3) {
          if (!draggedRef.current) {
            try {
              el.setPointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
          }
          draggedRef.current = true;
          userMovedRef.current = true;
          onUserInteractRef.current?.();
          apply({ k: panStart.cam.k, x: panStart.cam.x + dx, y: panStart.cam.y + dy });
        }
      }
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (!pointers.has(e.pointerId)) return; // already handled (el + window both listen)
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) {
        panStart = null;
        ignoreClickRef.current = draggedRef.current;
        draggedRef.current = false;
      } else if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        panStart = { px: p.x, py: p.y, cam: { ...camRef.current } };
      }
    };

    const onDblClick = (e: MouseEvent): void => {
      if ((e.target as Element).closest("[data-node]")) return;
      fitRef.current(true);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("dblclick", onDblClick);
    // un-captured pointers released outside the svg would otherwise go stale
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  useEffect(() => () => stopAnim(), []);

  return useMemo<CameraApi>(
    () => ({
      cam,
      transform: `translate(${cam.x}, ${cam.y}) scale(${cam.k})`,
      size,
      fit,
      flyTo: (wx, wy, o) => {
        const { w, h } = sizeRef.current;
        const k2 = Math.max(MIN_K, Math.min(MAX_K, o?.k ?? camRef.current.k));
        animateTo({ x: w / 2 - k2 * wx, y: h / 2 - k2 * wy, k: k2 }, o?.duration ?? 400);
      },
      zoomAt: (factor) => {
        const { w, h } = sizeRef.current;
        const c = camRef.current;
        const k2 = Math.max(MIN_K, Math.min(MAX_K, c.k * factor));
        animateTo(
          {
            k: k2,
            x: w / 2 - ((w / 2 - c.x) * k2) / c.k,
            y: h / 2 - ((h / 2 - c.y) * k2) / c.k,
          },
          150,
        );
      },
      screenFromWorld: (wx, wy) => ({ x: cam.x + cam.k * wx, y: cam.y + cam.k * wy }),
      inView: (wx, wy, margin = 60) => {
        const { w, h } = sizeRef.current;
        const sx = camRef.current.x + camRef.current.k * wx;
        const sy = camRef.current.y + camRef.current.k * wy;
        return sx >= margin && sx <= w - margin && sy >= margin && sy <= h - margin;
      },
      shouldIgnoreClick: () => {
        const v = ignoreClickRef.current;
        ignoreClickRef.current = false;
        return v;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cam, size],
  );
}

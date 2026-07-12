import { useEffect, useState } from "react";

// Fragment Mono is monospaced — analytic label widths (chars × advance) are
// exact once the real font is measured (spec §16). One shared advance cache.

const advances = new Map<number, number>();
let ctx: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D | null {
  if (ctx) return ctx;
  if (typeof document === "undefined") return null;
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

export function monoAdvance(px: number): number {
  const cached = advances.get(px);
  if (cached !== undefined) return cached;
  const c = context();
  let advance = px * 0.62; // fragment mono fallback ratio
  if (c) {
    c.font = `${px}px "Fragment Mono", monospace`;
    advance = c.measureText("0000000000").width / 10;
  }
  advances.set(px, advance);
  return advance;
}

export function labelWidth(text: string, px: number): number {
  return text.length * monoAdvance(px);
}

function clearMeasureCache(): void {
  advances.clear();
}

// ---------------------------------------------------------------------------
// font gate: initial layout waits for document.fonts.ready, capped at 800ms;
// if fonts land after the cap, re-measure and bump the version once (§16).
// ---------------------------------------------------------------------------

let fontsSettled = false;
let fontsVersionGlobal = 0;
const fontSubs = new Set<() => void>();

if (typeof document !== "undefined" && document.fonts?.ready) {
  document.fonts.ready.then(() => {
    fontsSettled = true;
    fontsVersionGlobal++;
    clearMeasureCache();
    fontSubs.forEach((cb) => cb());
  });
}

export function useFontGate(): { canMeasure: boolean; fontsVersion: number } {
  const [version, setVersion] = useState(fontsVersionGlobal);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const cb = () => setVersion(fontsVersionGlobal);
    fontSubs.add(cb);
    const t = window.setTimeout(() => setTimedOut(true), 800);
    return () => {
      fontSubs.delete(cb);
      window.clearTimeout(t);
    };
  }, []);

  return { canMeasure: fontsSettled || timedOut, fontsVersion: version };
}

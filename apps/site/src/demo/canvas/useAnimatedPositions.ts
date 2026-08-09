import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./useCamera";

type Pos = { x: number; y: number };

/**
 * Tweens node positions between layouts (expand/collapse, §7.1: 250ms ease-out).
 * New nodes enter from their parent's previous position; removed nodes drop out.
 */
export function useAnimatedPositions(
  target: Map<string, Pos>,
  parentOf: (id: string) => string | null,
  duration = 250,
): Map<string, Pos> {
  const [positions, setPositions] = useState(target);
  const currentRef = useRef<Map<string, Pos>>(target);
  const rafRef = useRef(0);
  const firstRef = useRef(true);

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (firstRef.current || prefersReducedMotion() || duration <= 0) {
      firstRef.current = false;
      currentRef.current = target;
      setPositions(target);
      return;
    }

    const starts = new Map<string, Pos>();
    const prev = currentRef.current;
    for (const [id, to] of target) {
      let from = prev.get(id);
      if (!from) {
        const pid = parentOf(id);
        from = (pid && (prev.get(pid) ?? target.get(pid))) || to;
      }
      starts.set(id, from);
    }

    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      const next = new Map<string, Pos>();
      for (const [id, to] of target) {
        const from = starts.get(id) ?? to;
        next.set(id, { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      }
      currentRef.current = next;
      setPositions(next);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else rafRef.current = 0;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return positions;
}

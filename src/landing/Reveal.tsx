import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Cinematic reveal (landing v2): rises 36px over 1.1s on an expo-out curve,
 * optionally un-blurring, staggered by `d` × 110ms. Inert under reduced motion
 * (css keeps it visible).
 */
export function Reveal({
  children,
  d = 0,
  blur = false,
  className = "",
}: {
  children: ReactNode;
  d?: number;
  blur?: boolean;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fire = (): void => el.classList.add("is-in");
    // already in the viewport: don't gate on IO delivery
    if (document.visibilityState !== "visible" || el.getBoundingClientRect().top < window.innerHeight) {
      const raf = requestAnimationFrame(() => requestAnimationFrame(fire));
      return () => cancelAnimationFrame(raf);
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            fire();
            io.disconnect();
          }
        }
      },
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${blur ? "reveal--blur" : ""} ${className}`.trim()}
      style={d ? { transitionDelay: `${d * 110}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/** the graph-language section marker: edge line, hollow dir, filled file */
export function GraphDivider({ center = false }: { center?: boolean }): JSX.Element {
  return (
    <svg
      className={center ? "graph-divider graph-divider--center" : "graph-divider"}
      width="88"
      height="14"
      viewBox="0 0 88 14"
      aria-hidden="true"
    >
      <line x1="0" y1="7" x2="30" y2="7" stroke="#2B2B27" strokeWidth="1" />
      <circle cx="37" cy="7" r="5" fill="none" stroke="#55554E" strokeWidth="1.5" />
      <line x1="44" y1="7" x2="70" y2="7" stroke="#2B2B27" strokeWidth="1" />
      <circle cx="75" cy="7" r="3.5" fill="#4F7F5D" />
    </svg>
  );
}

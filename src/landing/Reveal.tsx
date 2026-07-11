import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/** scroll-triggered reveal — fades/rises once when 15% visible; inert under reduced motion (css) */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add("is-in");
            io.disconnect();
          }
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${className}`.trim()} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}

/** the graph-language section marker: edge line, hollow dir, filled file, lit tip */
export function GraphDivider(): JSX.Element {
  return (
    <svg className="graph-divider" width="88" height="14" viewBox="0 0 88 14" aria-hidden="true">
      <line x1="0" y1="7" x2="30" y2="7" stroke="var(--edge)" strokeWidth="1" />
      <circle cx="37" cy="7" r="5" fill="none" stroke="var(--node-stroke)" strokeWidth="1.5" />
      <line x1="44" y1="7" x2="70" y2="7" stroke="var(--edge)" strokeWidth="1" />
      <circle cx="75" cy="7" r="3.5" fill="var(--accent)" />
    </svg>
  );
}

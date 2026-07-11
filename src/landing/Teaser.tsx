import { useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";
import { useNavigate } from "react-router-dom";
import { HERO } from "../data/copy";
import { FeaturesView } from "../demo/canvas/FeaturesView";
import { FiletreeView } from "../demo/canvas/FiletreeView";
import { RelationsView } from "../demo/canvas/RelationsView";
import { prefersReducedMotion } from "../demo/canvas/useCamera";
import { personaLayers, useDemoState } from "../demo/state";
import type { DemoAction } from "../demo/state";
import { CanvasSandbox } from "./CanvasSandbox";

const PAYMENT_FORM = "apps/web/src/checkout/PaymentForm.tsx";

// 12s scripted attract loop (§11): select PaymentForm → new hire relations,
// drill apps/ → pm features, checkout selected → back to start.
const SCRIPT: { at: number; run: (d: Dispatch<DemoAction>) => void }[] = [
  {
    at: 600,
    run: (d) => d({ type: "selectFileForTab", id: PAYMENT_FORM }),
  },
  {
    at: 3600,
    run: (d) => {
      d({ type: "setScope", id: "acme" });
      d({ type: "setPersona", id: "new-hire" });
      d({ type: "setLayers", layers: personaLayers("new-hire") });
    },
  },
  { at: 6400, run: (d) => d({ type: "drill", id: "apps" }) },
  {
    at: 9000,
    run: (d) => {
      d({ type: "setPersona", id: "pm" });
      d({ type: "setLayers", layers: personaLayers("pm") });
      d({ type: "selectFeature", id: "checkout" });
    },
  },
  {
    at: 12000,
    run: (d) => {
      d({ type: "setPersona", id: "tech-lead" });
      d({ type: "setLayers", layers: personaLayers("tech-lead") });
      d({ type: "setScope", id: "acme" });
      d({ type: "selectNode", id: null });
    },
  },
];

function TeaserCanvas(): JSX.Element {
  const state = useDemoState();
  return (
    <>
      {state.tab === "filetree" && <FiletreeView interactive={false} />}
      {state.tab === "features" && <FeaturesView interactive={false} />}
      {state.tab === "relations" && <RelationsView interactive={false} />}
    </>
  );
}

export function Teaser(): JSX.Element {
  const navigate = useNavigate();
  const dispatchRef = useRef<Dispatch<DemoAction> | null>(null);
  const [hovered, setHovered] = useState(false);
  const hoveredRef = useRef(false);
  hoveredRef.current = hovered;

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let disposed = false;
    let timer = 0;
    let idx = 0;

    const scheduleNext = (delay: number): void => {
      timer = window.setTimeout(() => {
        if (disposed) return;
        if (hoveredRef.current) {
          // paused — poll until unhovered, then continue
          scheduleNext(300);
          return;
        }
        const step = SCRIPT[idx];
        if (dispatchRef.current) step.run(dispatchRef.current);
        const next = (idx + 1) % SCRIPT.length;
        const gap = next === 0 ? SCRIPT[0].at + 800 : SCRIPT[next].at - step.at;
        idx = next;
        scheduleNext(gap);
      }, delay);
    };

    // defer attract start so hero text paint never waits on the canvas (§16)
    const start = (): void => {
      if (disposed) return;
      scheduleNext(SCRIPT[0].at);
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const idleId = idle ? idle(start) : window.setTimeout(start, 350);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (!idle) window.clearTimeout(idleId as number);
    };
  }, []);

  const frameRef = useRef<HTMLDivElement | null>(null);

  const onParallax = (e: React.MouseEvent): void => {
    const el = frameRef.current;
    if (!el || prefersReducedMotion()) return;
    const r = el.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5; // -0.5 … 0.5
    const ny = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--tilt-x", `${(nx * 3).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${(-ny * 2.4).toFixed(2)}deg`);
  };

  const resetParallax = (): void => {
    const el = frameRef.current;
    if (!el) return;
    el.style.setProperty("--tilt-x", "0deg");
    el.style.setProperty("--tilt-y", "0deg");
  };

  return (
    <div
      ref={frameRef}
      className="teaser"
      role="link"
      aria-label="open the live demo"
      tabIndex={0}
      onClick={() => navigate("/demo")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate("/demo");
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        resetParallax();
      }}
      onMouseMove={onParallax}
    >
      <div className="teaser__canvas" aria-hidden="true">
        <CanvasSandbox dispatchRef={dispatchRef}>
          <TeaserCanvas />
        </CanvasSandbox>
      </div>
      {(hovered || prefersReducedMotion()) && <span className="teaser__chip">{HERO.teaserChip}</span>}
    </div>
  );
}

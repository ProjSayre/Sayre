import { useEffect, useRef, useState } from "react";
import { TOUR_STEPS } from "../../data/tour";
import type { TourAction } from "../../data/tour";
import { Button } from "../../shared/Button";
import { prefersReducedMotion } from "../canvas/useCamera";
import { useCanvasBus, useDemoDispatch } from "../state";

const CARD_W = 340;

export function Tour({
  onFinish,
  onConvert,
}: {
  onFinish: () => void; // completing or skipping — caller sets the seen flag
  onConvert: () => void; // final step CTA → waitlist modal
}): JSX.Element {
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const [stepIdx, setStepIdx] = useState(0);
  const [anchorPos, setAnchorPos] = useState<{ x: number; y: number } | null>(null);
  const cancelRef = useRef(false);

  const step = TOUR_STEPS[stepIdx];

  // execute the step's real state changes through the reducers
  useEffect(() => {
    cancelRef.current = false;
    const pace = prefersReducedMotion() ? 0 : 300;
    let t = 60;
    const timers: number[] = [];

    const run = (a: TourAction): void => {
      switch (a.kind) {
        case "deselect":
          dispatch({ type: "selectNode", id: null });
          break;
        case "tab":
          dispatch({ type: "setTab", tab: a.tab });
          break;
        case "persona":
          dispatch({ type: "setPersona", id: a.id });
          break;
        case "select":
          dispatch({ type: "selectNode", id: a.id });
          break;
        case "selectFile":
          dispatch({ type: "selectFileForTab", id: a.id });
          break;
        case "selectFeature":
          dispatch({ type: "selectFeature", id: a.id });
          break;
        case "scope":
          dispatch({ type: "setScope", id: a.id });
          break;
        case "drill":
          dispatch({ type: "drill", id: a.id });
          break;
        case "fit":
          bus.current?.fit();
          break;
        case "flyTo":
          bus.current?.flyToNode(a.id);
          break;
      }
    };

    for (const action of step.actions) {
      const delay = action.kind === "fit" || action.kind === "flyTo" ? t + 140 : t;
      timers.push(window.setTimeout(() => !cancelRef.current && run(action), delay));
      t += pace;
    }
    return () => {
      cancelRef.current = true;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx]);

  // Esc skips
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onFinish();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // follow the anchor while the camera settles
  useEffect(() => {
    if (step.anchor.kind === "center") {
      setAnchorPos(null);
      return;
    }
    const id = step.anchor.id;
    const tick = (): void => {
      const p = bus.current?.nodeScreenPos(id) ?? null;
      setAnchorPos((prev) => {
        if (prev && p && Math.abs(prev.x - p.x) < 1 && Math.abs(prev.y - p.y) < 1) return prev;
        return p;
      });
    };
    tick();
    const iv = window.setInterval(tick, 140);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  let style: React.CSSProperties;
  if (step.anchor.kind === "center" || !anchorPos) {
    style = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  } else {
    const flipX = anchorPos.x + 28 + CARD_W > vw;
    const left = flipX ? Math.max(12, anchorPos.x - CARD_W - 28) : anchorPos.x + 28;
    const top = Math.max(64, Math.min(anchorPos.y - 30, vh - 220));
    style = { left, top };
  }

  return (
    <div className="tour">
      {/* input outside the card is ignored while active (§9) */}
      <div className="tour__blocker" aria-hidden="true" />
      <div className="tour__card" role="dialog" aria-label={`tour step ${stepIdx + 1} of ${TOUR_STEPS.length}`} style={style}>
        <p className="tour__caption">{step.caption}</p>
        <div className="tour__footer">
          <span className="tour__progress">
            {stepIdx + 1} / {TOUR_STEPS.length}
          </span>
          {step.final ? (
            <span className="tour__actions">
              <Button small onClick={onConvert}>
                get early access
              </Button>
              <Button small variant="secondary" onClick={onFinish}>
                keep exploring
              </Button>
            </span>
          ) : (
            <span className="tour__actions">
              <button className="tour__skip" onClick={onFinish}>
                skip
              </button>
              <button className="tour__next" onClick={() => setStepIdx((i) => Math.min(TOUR_STEPS.length - 1, i + 1))}>
                next →
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

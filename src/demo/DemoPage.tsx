import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { NODE_BY_ID } from "../data";
import { TOUR_SEEN_KEY } from "../data/tour";
import { Modal } from "../shared/Modal";
import { WaitlistForm } from "../shared/WaitlistForm";
import type { WaitlistSource } from "../shared/WaitlistForm";
import { FeaturesView } from "./canvas/FeaturesView";
import { FiletreeView } from "./canvas/FiletreeView";
import { RelationsView } from "./canvas/RelationsView";
import { prefersReducedMotion } from "./canvas/useCamera";
import { CommandK } from "./search/CommandK";
import { Sidebar } from "./Sidebar";
import {
  CanvasBusContext,
  DemoDispatchContext,
  DemoStateContext,
  LAYER_ORDER,
  ZoomStoreContext,
  createZoomStore,
  demoReducer,
  initialDemoState,
  personaLayers,
} from "./state";
import type { CanvasBus } from "./state";
import { StatusLine } from "./StatusLine";
import { TopBar, PersonaSwitcher } from "./TopBar";
import { Tour } from "./tour/Tour";
import { TreePanel } from "./TreePanel";
import type { PanelMode } from "./TreePanel";

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const cb = (): void => setMatches(mq.matches);
    cb();
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, [query]);
  return matches;
}

function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    /* private mode */
  }
}

export default function DemoPage(): JSX.Element {
  const [state, dispatch] = useReducer(demoReducer, undefined, initialDemoState);
  const busRef = useRef<CanvasBus | null>(null);
  const zoomStore = useMemo(createZoomStore, []);

  const isMobile = useMedia("(max-width: 899px)");
  const isNarrow = useMedia("(min-width: 900px) and (max-width: 1100px)");

  const [searchOpen, setSearchOpen] = useState(false);
  const [waitlistSource, setWaitlistSource] = useState<WaitlistSource | null>(null);
  const [tourActive, setTourActive] = useState(false);
  const [chipVisible, setChipVisible] = useState(false);
  const [panelUserCollapsed, setPanelUserCollapsed] = useState<boolean | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("tree");
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const interactionsRef = useRef(0);

  const panelCollapsed = panelUserCollapsed ?? isNarrow;

  useEffect(() => {
    const prev = document.title;
    document.title = "sayre_ — live demo";
    return () => {
      document.title = prev;
    };
  }, []);

  // tour prompt chip: 1.5s after first visit; never autoplay (§9)
  useEffect(() => {
    if (tourSeen()) return;
    const t = window.setTimeout(() => {
      if (interactionsRef.current < 3) setChipVisible(true);
    }, 1500);
    return () => window.clearTimeout(t);
  }, []);

  const countInteraction = (): void => {
    interactionsRef.current += 1;
    // 3 canvas interactions merely hide the chip for the session (no flag)
    if (interactionsRef.current >= 3) setChipVisible(false);
  };

  // persona switch: stagger the checkbox preset ~40ms apart (§8.6)
  const prevPersonaRef = useRef(state.persona);
  const layersRef = useRef(state.layers);
  layersRef.current = state.layers;
  useEffect(() => {
    if (prevPersonaRef.current === state.persona) return;
    prevPersonaRef.current = state.persona;
    const preset = personaLayers(state.persona);
    if (prefersReducedMotion()) {
      dispatch({ type: "setLayers", layers: preset });
      return;
    }
    const diffs = LAYER_ORDER.filter((k) => layersRef.current[k] !== preset[k]);
    const timers = diffs.map((key, i) =>
      window.setTimeout(() => dispatch({ type: "setLayer", key, on: preset[key] }), 80 + i * 40),
    );
    return () => timers.forEach(clearTimeout);
  }, [state.persona]);

  // global keys: ⌘k / ctrl+k, + - 0 zoom, [ tree panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isMobile) {
          setSearchOpen((o) => !o);
        } else {
          // search lives in the left panel on desktop (design v2)
          setPanelUserCollapsed(false);
          setPanelMode("search");
          setSearchFocusToken((n) => n + 1);
        }
        return;
      }
      if (tourActive || searchOpen || waitlistSource !== null) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") busRef.current?.zoomAt(1.25);
      else if (e.key === "-") busRef.current?.zoomAt(0.8);
      else if (e.key === "0") busRef.current?.fit();
      else if (e.key === "[") setPanelUserCollapsed((c) => !(c ?? isNarrow));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tourActive, searchOpen, waitlistSource, isNarrow, isMobile]);

  const startTour = (): void => {
    setChipVisible(false);
    setSheetOpen(false);
    setTourActive(true);
  };

  const finishTour = (): void => {
    setTourActive(false);
    markTourSeen();
  };

  const selectedNode = state.selectedId ? NODE_BY_ID.get(state.selectedId) : null;

  return (
    <DemoStateContext.Provider value={state}>
      <DemoDispatchContext.Provider value={dispatch}>
        <CanvasBusContext.Provider value={busRef}>
          <ZoomStoreContext.Provider value={zoomStore}>
            <div className="demo">
              <TopBar onEarlyAccess={() => setWaitlistSource("demo-topbar")} isMobile={isMobile} />
              <div className="demo__body">
                {!isMobile && (
                  <TreePanel
                    collapsed={panelCollapsed}
                    onToggleCollapsed={() => setPanelUserCollapsed(!panelCollapsed)}
                    mode={panelMode}
                    onModeChange={setPanelMode}
                    searchFocusToken={searchFocusToken}
                  />
                )}

                <main className="demo__canvas-area" onPointerDownCapture={countInteraction}>
                  {state.tab === "filetree" && <FiletreeView onUserInteract={countInteraction} />}
                  {state.tab === "features" && <FeaturesView onUserInteract={countInteraction} />}
                  {state.tab === "relations" && <RelationsView onUserInteract={countInteraction} />}

                  {isMobile && (
                    <button className="cmdk-hint cmdk-hint--icon" aria-label="search files" onClick={() => setSearchOpen(true)}>
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                        <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        <line x1="9.5" y1="9.5" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    </button>
                  )}

                  <StatusLine onTour={startTour} showTour={!tourActive} />

                  {chipVisible && !tourActive && (
                    <div className="tour-chip" role="dialog" aria-label="tour offer">
                      take the 30-second tour?
                      <button className="tour-chip__start" onClick={startTour}>
                        start
                      </button>
                      <button
                        className="tour-chip__dismiss"
                        onClick={() => {
                          setChipVisible(false);
                          markTourSeen();
                        }}
                      >
                        dismiss
                      </button>
                    </div>
                  )}
                </main>

                {!isMobile && (
                  <aside className="sidebar" aria-label="inspector">
                    <Sidebar />
                  </aside>
                )}
              </div>

              {isMobile && (
                <div className={sheetOpen ? "sheet is-open" : "sheet"}>
                  <button
                    className="sheet__bar"
                    aria-expanded={sheetOpen}
                    onClick={() => setSheetOpen((o) => !o)}
                  >
                    <span className="sheet__grab" aria-hidden="true" />
                    {selectedNode
                      ? selectedNode.type === "file"
                        ? selectedNode.name
                        : selectedNode.name + "/"
                      : "acme/monorepo · tap a node to inspect"}
                  </button>
                  {sheetOpen && (
                    <div className="sheet__body">
                      <div className="sheet__persona">
                        <PersonaSwitcher pinned />
                      </div>
                      <Sidebar variant="sheet" />
                    </div>
                  )}
                </div>
              )}

              {searchOpen && <CommandK onClose={() => setSearchOpen(false)} />}

              {waitlistSource !== null && (
                <Modal onClose={() => setWaitlistSource(null)} label="get early access">
                  <h2 className="waitlist-modal__title">get early access</h2>
                  <p className="waitlist-modal__body">
                    linked here from an email? this demo is sample data — the waitlist gets sayre on yours.
                  </p>
                  <WaitlistForm source={waitlistSource} />
                </Modal>
              )}

              {tourActive && (
                <Tour
                  onFinish={finishTour}
                  onConvert={() => {
                    finishTour();
                    setWaitlistSource("demo-tour");
                  }}
                />
              )}
            </div>
          </ZoomStoreContext.Provider>
        </CanvasBusContext.Provider>
      </DemoDispatchContext.Provider>
    </DemoStateContext.Provider>
  );
}

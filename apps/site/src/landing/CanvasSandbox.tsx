import { useMemo, useReducer, useRef } from "react";
import type { Dispatch, ReactNode } from "react";
import {
  CanvasBusContext,
  DemoDispatchContext,
  DemoStateContext,
  ZoomStoreContext,
  createZoomStore,
  demoReducer,
  initialDemoState,
} from "../demo/state";
import type { CanvasBus, DemoAction, DemoState } from "../demo/state";

/**
 * Wraps the real demo canvas components in an isolated state island so the
 * landing page can render them (teaser attract mode + static deep dives)
 * without the demo chrome.
 */
export function CanvasSandbox({
  setup,
  children,
  dispatchRef,
}: {
  setup?: (s: DemoState) => DemoState;
  children: ReactNode;
  dispatchRef?: React.MutableRefObject<Dispatch<DemoAction> | null>;
}): JSX.Element {
  const [state, dispatch] = useReducer(demoReducer, undefined, () => {
    const base = initialDemoState();
    return setup ? setup(base) : base;
  });
  const busRef = useRef<CanvasBus | null>(null);
  const zoomStore = useMemo(createZoomStore, []);
  if (dispatchRef) dispatchRef.current = dispatch;

  return (
    <DemoStateContext.Provider value={state}>
      <DemoDispatchContext.Provider value={dispatch}>
        <CanvasBusContext.Provider value={busRef}>
          <ZoomStoreContext.Provider value={zoomStore}>{children}</ZoomStoreContext.Provider>
        </CanvasBusContext.Provider>
      </DemoDispatchContext.Provider>
    </DemoStateContext.Provider>
  );
}

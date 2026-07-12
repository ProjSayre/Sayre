import { createContext, useContext } from "react";
import type { Dispatch } from "react";
import {
  INITIAL_EXPANDED,
  INITIAL_PERSONA,
  NODE_BY_ID,
  PERSONAS,
  ROOT_ID,
  ancestorIds,
} from "../data";
import type { LayerKey, PersonaId, Tab } from "../data";

export const LAYER_ORDER: LayerKey[] = [
  "description",
  "dependencies",
  "recentChanges",
  "features",
  "tickets",
  "agentMd",
  "tests",
];

export const LAYER_LABELS: Record<LayerKey, string> = {
  description: "description",
  dependencies: "dependencies",
  recentChanges: "recent changes",
  features: "specific features",
  tickets: "specific tickets",
  agentMd: "agent / skill md",
  tests: "tests",
};

export function personaLayers(id: PersonaId): Record<LayerKey, boolean> {
  const persona = PERSONAS.find((p) => p.id === id) ?? INITIAL_PERSONA;
  const out = {} as Record<LayerKey, boolean>;
  for (const key of LAYER_ORDER) out[key] = persona.layers.includes(key);
  return out;
}

export interface DemoState {
  tab: Tab;
  persona: PersonaId;
  selectedId: string | null;
  selectedFeatureId: string | null;
  expandedIds: ReadonlySet<string>;
  layers: Record<LayerKey, boolean>;
  relationsScope: string;
  edgeKinds: { imports: boolean; calls: boolean };
}

export type DemoAction =
  | { type: "selectNode"; id: string | null }
  | { type: "clickTreeNode"; id: string }
  | { type: "selectFileForTab"; id: string }
  | { type: "toggleExpand"; id: string }
  | { type: "setTab"; tab: Tab }
  | { type: "setPersona"; id: PersonaId }
  | { type: "setLayer"; key: LayerKey; on: boolean }
  | { type: "setLayers"; layers: Record<LayerKey, boolean> }
  | { type: "selectFeature"; id: string }
  | { type: "setScope"; id: string }
  | { type: "drill"; id: string }
  | { type: "scopeUp" }
  | { type: "toggleEdgeKind"; kind: "imports" | "calls" };

export function initialDemoState(): DemoState {
  return {
    tab: INITIAL_PERSONA.defaultTab,
    persona: INITIAL_PERSONA.id,
    selectedId: null,
    selectedFeatureId: null,
    expandedIds: new Set(INITIAL_EXPANDED),
    layers: personaLayers(INITIAL_PERSONA.id),
    relationsScope: ROOT_ID,
    edgeKinds: { imports: true, calls: true },
  };
}

function withExpanded(state: DemoState, ids: string[]): ReadonlySet<string> {
  const missing = ids.filter((id) => !state.expandedIds.has(id));
  if (missing.length === 0) return state.expandedIds;
  const next = new Set(state.expandedIds);
  for (const id of missing) next.add(id);
  return next;
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "selectNode": {
      if (action.id === null) {
        if (state.selectedId === null && state.selectedFeatureId === null) return state;
        return { ...state, selectedId: null, selectedFeatureId: null };
      }
      return { ...state, selectedId: action.id, selectedFeatureId: null };
    }

    case "clickTreeNode": {
      const node = NODE_BY_ID.get(action.id);
      if (!node) return state;
      if (node.type === "file") {
        return { ...state, selectedId: node.id, selectedFeatureId: null };
      }
      const isSelected = state.selectedId === node.id;
      const isExpanded = state.expandedIds.has(node.id);
      if (isSelected && isExpanded) {
        // collapse, keep selection
        const next = new Set(state.expandedIds);
        next.delete(node.id);
        return { ...state, expandedIds: next };
      }
      // select + expand (also re-selects an expanded folder without collapsing)
      const expandedIds = isExpanded ? state.expandedIds : withExpanded(state, [node.id]);
      return { ...state, selectedId: node.id, selectedFeatureId: null, expandedIds };
    }

    case "selectFileForTab": {
      const node = NODE_BY_ID.get(action.id);
      if (!node) return state;
      if (state.tab === "filetree") {
        return {
          ...state,
          selectedId: node.id,
          selectedFeatureId: null,
          expandedIds: withExpanded(state, ancestorIds(node.id)),
        };
      }
      if (state.tab === "relations") {
        const scope = node.type === "file" ? (node.parentId ?? ROOT_ID) : node.id;
        return {
          ...state,
          selectedId: node.id,
          selectedFeatureId: null,
          relationsScope: node.type === "file" ? scope : state.relationsScope,
        };
      }
      return { ...state, selectedId: node.id, selectedFeatureId: null };
    }

    case "toggleExpand": {
      const node = NODE_BY_ID.get(action.id);
      if (!node || node.type === "file") return state;
      const next = new Set(state.expandedIds);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return { ...state, expandedIds: next };
    }

    case "setTab": {
      if (action.tab === state.tab) return state;
      return {
        ...state,
        tab: action.tab,
        // feature selection is Features-tab-scoped (§7.4)
        selectedFeatureId: action.tab === "features" ? state.selectedFeatureId : null,
      };
    }

    case "setPersona": {
      const persona = PERSONAS.find((p) => p.id === action.id);
      if (!persona || persona.id === state.persona) return state;
      return {
        ...state,
        persona: persona.id,
        tab: persona.defaultTab,
        selectedFeatureId: persona.defaultTab === "features" ? state.selectedFeatureId : null,
        // node selection survives (§8.6); layers are staggered in by the controller
      };
    }

    case "setLayer": {
      if (state.layers[action.key] === action.on) return state;
      return { ...state, layers: { ...state.layers, [action.key]: action.on } };
    }

    case "setLayers":
      return { ...state, layers: action.layers };

    case "selectFeature":
      return { ...state, selectedFeatureId: action.id, selectedId: null };

    case "setScope": {
      const node = NODE_BY_ID.get(action.id);
      if (!node || node.type === "file") return state;
      if (state.relationsScope === action.id) return state;
      return { ...state, relationsScope: action.id };
    }

    case "drill": {
      const node = NODE_BY_ID.get(action.id);
      if (!node || node.type === "file") return state;
      // drilled dir stays selected (§7.5)
      return { ...state, relationsScope: action.id, selectedId: action.id, selectedFeatureId: null };
    }

    case "scopeUp": {
      const parent = NODE_BY_ID.get(state.relationsScope)?.parentId;
      if (!parent) return state;
      return { ...state, relationsScope: parent };
    }

    case "toggleEdgeKind": {
      const next = { ...state.edgeKinds, [action.kind]: !state.edgeKinds[action.kind] };
      return { ...state, edgeKinds: next };
    }
  }
}

// ---------------------------------------------------------------------------
// contexts
// ---------------------------------------------------------------------------

export const DemoStateContext = createContext<DemoState | null>(null);
export const DemoDispatchContext = createContext<Dispatch<DemoAction> | null>(null);

export function useDemoState(): DemoState {
  const s = useContext(DemoStateContext);
  if (!s) throw new Error("useDemoState outside provider");
  return s;
}

export function useDemoDispatch(): Dispatch<DemoAction> {
  const d = useContext(DemoDispatchContext);
  if (!d) throw new Error("useDemoDispatch outside provider");
  return d;
}

/** imperative bridge to the active canvas (camera moves from panel/search/tour) */
export interface CanvasBus {
  flyToNode: (id: string) => void;
  fit: () => void;
  zoomAt: (factor: number) => void;
  /** viewport coords of a node/feature on the active canvas (tour anchoring) */
  nodeScreenPos: (id: string) => { x: number; y: number } | null;
}

export const CanvasBusContext = createContext<{ current: CanvasBus | null } | null>(null);

export function useCanvasBus(): { current: CanvasBus | null } {
  const b = useContext(CanvasBusContext);
  if (!b) throw new Error("useCanvasBus outside provider");
  return b;
}

// tiny external store for the live zoom readout (avoids re-rendering the tree on pan/zoom)
export interface ZoomStore {
  get: () => number;
  set: (k: number) => void;
  subscribe: (cb: () => void) => () => void;
}

export function createZoomStore(): ZoomStore {
  let value = 1;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (k) => {
      if (k === value) return;
      value = k;
      subs.forEach((cb) => cb());
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

export const ZoomStoreContext = createContext<ZoomStore | null>(null);

export function useZoomStore(): ZoomStore {
  const z = useContext(ZoomStoreContext);
  if (!z) throw new Error("useZoomStore outside provider");
  return z;
}

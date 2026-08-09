import { useMemo, useSyncExternalStore } from "react";
import { CHILDREN, FEATURES, FEATURE_FILE_TOTAL, NODE_BY_ID, ancestorIds } from "../data";
import { visibleTreeItems } from "./canvas/layout";
import { fileCounterparts, rollupScope } from "./canvas/rollup";
import { useDemoState, useZoomStore } from "./state";

export function StatusLine({ onTour, showTour }: { onTour: () => void; showTour: boolean }): JSX.Element {
  const state = useDemoState();
  const zoomStore = useZoomStore();
  const zoom = useSyncExternalStore(zoomStore.subscribe, zoomStore.get, () => 1);

  const depth = useMemo(() => {
    if (state.tab !== "filetree") return 0;
    let max = 0;
    for (const item of visibleTreeItems(state.expandedIds)) {
      if (item.kind === "node") max = Math.max(max, item.depth);
    }
    return max + 1; // levels, matching the mock's "depth 4"
  }, [state.tab, state.expandedIds]);

  const parts: string[] = [];

  if (state.tab === "filetree") {
    parts.push(`zoom ${Math.round(zoom * 100)}%`, "tree layout", `depth ${depth}`);
  } else if (state.tab === "features") {
    parts.push(`zoom ${Math.round(zoom * 100)}%`, `${FEATURES.length} features`, `${FEATURE_FILE_TOTAL} files`);
  } else {
    const crumb = [...ancestorIds(state.relationsScope), state.relationsScope]
      .map((id) => (NODE_BY_ID.get(id)?.name ?? id) + "/")
      .join(" › ");
    const kids = rollupScope(state.relationsScope, state.edgeKinds);
    parts.push("relations", crumb);
    parts.push(`${childCount(state.relationsScope)} nodes`, `${kids.length} edges`);
    const kindLabel = [state.edgeKinds.imports ? "imports" : null, state.edgeKinds.calls ? "calls" : null]
      .filter(Boolean)
      .join(" + ");
    parts.push(kindLabel === "" ? "no edge kinds" : kindLabel);
    if (kids.length === 0) parts.push("no detected relations at this level");
    const sel = state.selectedId ? NODE_BY_ID.get(state.selectedId) : null;
    if (sel && sel.type === "file") {
      const { incoming, outgoing } = fileCounterparts(sel.id, state.edgeKinds);
      parts.push(sel.name, `${incoming.length} in`, `${outgoing.length} out`);
    }
  }

  parts.push("sample data");

  return (
    <div className="statusline">
      <span className="statusline__text">{parts.join(" · ")}</span>
      {showTour && (
        <button className="statusline__tour" onClick={onTour}>
          tour
        </button>
      )}
    </div>
  );
}

function childCount(scopeId: string): number {
  return (CHILDREN.get(scopeId) ?? []).length;
}

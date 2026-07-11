import { useEffect, useMemo, useRef } from "react";
import { useCanvasBus, useDemoDispatch, useDemoState } from "./state";
import { visibleTreeItems } from "./canvas/layout";

/**
 * IDE-style left tree panel (§6.5). Shares expandedIds + selection with the
 * canvas: dir clicks run the same reducer as canvas clicks on every tab; the
 * panel never drills or re-scopes on dir clicks.
 */
export function TreePanel({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const listRef = useRef<HTMLUListElement | null>(null);

  const items = useMemo(() => visibleTreeItems(state.expandedIds), [state.expandedIds]);

  // auto-scroll selection into view (§6.5)
  useEffect(() => {
    if (!state.selectedId || collapsed) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(state.selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [state.selectedId, collapsed]);

  const onFileClick = (id: string): void => {
    dispatch({ type: "selectFileForTab", id });
    // canvas response per tab: filetree flies to the node; features centers the
    // containing ring; relations re-scopes (its bus resolves the new position)
    window.setTimeout(() => bus.current?.flyToNode(id), 30);
  };

  const onKeyNav = (e: React.KeyboardEvent, id: string, isFolder: boolean, expanded: boolean): void => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-id]");
    if (!rows) return;
    const arr = [...rows];
    const i = arr.findIndex((r) => r.dataset.id === id);
    if (e.key === "ArrowDown" && i < arr.length - 1) {
      e.preventDefault();
      arr[i + 1].focus();
    } else if (e.key === "ArrowUp" && i > 0) {
      e.preventDefault();
      arr[i - 1].focus();
    } else if (e.key === "ArrowRight" && isFolder && !expanded) {
      e.preventDefault();
      dispatch({ type: "toggleExpand", id });
    } else if (e.key === "ArrowLeft" && isFolder && expanded) {
      e.preventDefault();
      dispatch({ type: "toggleExpand", id });
    }
  };

  if (collapsed) {
    return (
      <div className="treepanel treepanel--collapsed">
        <button className="treepanel__toggle" aria-label="expand tree panel" title="expand tree panel ( [ )" onClick={onToggleCollapsed}>
          »
        </button>
      </div>
    );
  }

  return (
    <div className="treepanel">
      <div className="treepanel__head">
        <span className="treepanel__title">acme/monorepo</span>
        <button className="treepanel__toggle" aria-label="collapse tree panel" title="collapse tree panel ( [ )" onClick={onToggleCollapsed}>
          «
        </button>
      </div>
      <ul className="treepanel__list" role="tree" aria-label="repository tree" ref={listRef}>
        {items.map((item) => {
          if (item.kind === "ghost") {
            return (
              <li key={item.id} role="none" className="treepanel__ghost" style={{ paddingLeft: 10 + item.depth * 14 }}>
                {item.label}
              </li>
            );
          }
          const node = item.node;
          const isFolder = node.type !== "file";
          const expanded = state.expandedIds.has(node.id);
          const selected = state.selectedId === node.id;
          return (
            <li key={item.id} role="none">
              <div
                role="treeitem"
                aria-expanded={isFolder ? expanded : undefined}
                aria-selected={selected}
                aria-level={item.depth + 1}
                tabIndex={selected || (item.depth === 0 && !state.selectedId) ? 0 : -1}
                data-id={node.id}
                className={[
                  "treepanel__row",
                  isFolder ? "treepanel__row--dir" : "treepanel__row--file",
                  selected ? "is-selected" : "",
                ].join(" ")}
                style={{ paddingLeft: 10 + item.depth * 14 }}
                onClick={() => (isFolder ? dispatch({ type: "clickTreeNode", id: node.id }) : onFileClick(node.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (isFolder) dispatch({ type: "clickTreeNode", id: node.id });
                    else onFileClick(node.id);
                    return;
                  }
                  onKeyNav(e, node.id, isFolder, expanded);
                }}
              >
                {isFolder ? node.name + "/" : node.name}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

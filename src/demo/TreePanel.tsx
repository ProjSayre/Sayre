import { useEffect, useMemo, useRef, useState } from "react";
import { NODE_BY_ID } from "../data";
import { useCanvasBus, useDemoDispatch, useDemoState } from "./state";
import { visibleTreeItems } from "./canvas/layout";
import { useFileSearch } from "./search/useFileSearch";

export type PanelMode = "tree" | "search";

/**
 * IDE-style left panel (§6.5 + design v2): `tree` mirrors the canvas; `search`
 * hosts the fuzzy file search (⌘k focuses it on desktop). Dir clicks run the
 * same reducer as canvas clicks on every tab; the panel never drills.
 */
export function TreePanel({
  collapsed,
  onToggleCollapsed,
  mode,
  onModeChange,
  searchFocusToken,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mode: PanelMode;
  onModeChange: (m: PanelMode) => void;
  searchFocusToken: number;
}): JSX.Element {
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
      <div className="treepanel__modes" role="tablist" aria-label="panel mode">
        <button
          role="tab"
          aria-selected={mode === "tree"}
          className={mode === "tree" ? "treepanel__mode is-active" : "treepanel__mode"}
          onClick={() => onModeChange("tree")}
        >
          tree
        </button>
        <button
          role="tab"
          aria-selected={mode === "search"}
          className={mode === "search" ? "treepanel__mode is-active" : "treepanel__mode"}
          onClick={() => onModeChange("search")}
        >
          search
        </button>
        <button className="treepanel__toggle" aria-label="collapse tree panel" title="collapse tree panel ( [ )" onClick={onToggleCollapsed}>
          «
        </button>
      </div>
      {mode === "tree" ? <TreeList /> : <SearchPane focusToken={searchFocusToken} onExit={() => onModeChange("tree")} />}
    </div>
  );
}

function TreeList(): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const listRef = useRef<HTMLUListElement | null>(null);

  const items = useMemo(() => visibleTreeItems(state.expandedIds), [state.expandedIds]);

  // auto-scroll selection into view (§6.5)
  useEffect(() => {
    if (!state.selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(state.selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [state.selectedId]);

  const onFileClick = (id: string): void => {
    dispatch({ type: "selectFileForTab", id });
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

  return (
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
  );
}

function SearchPane({ focusToken, onExit }: { focusToken: number; onExit: () => void }): JSX.Element {
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rows = useFileSearch(query, 12);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => setActive(0), [query]);

  const choose = (id: string): void => {
    dispatch({ type: "selectFileForTab", id });
    window.setTimeout(() => bus.current?.flyToNode(id), 30);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onExit();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && rows[active]) {
      e.preventDefault();
      choose(rows[active].id);
    }
  };

  return (
    <div className="treepanel__search" onKeyDown={onKeyDown}>
      <div className="treepanel__searchbox">
        <input
          ref={inputRef}
          className="treepanel__searchinput"
          placeholder="search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="panel-search-results"
          aria-activedescendant={rows[active] ? `panel-row-${active}` : undefined}
          aria-label="search files"
        />
        <span className="treepanel__searchhint" aria-hidden="true">
          ⌘k
        </span>
      </div>
      <div className="treepanel__results" id="panel-search-results" role="listbox">
        {rows.length === 0 ? (
          <div className="treepanel__noresults">no files match</div>
        ) : (
          rows.map((row, i) => {
            const node = NODE_BY_ID.get(row.id);
            if (!node) return null;
            return (
              <div
                key={row.id}
                id={`panel-row-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "treepanel__result is-active" : "treepanel__result"}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(row.id)}
              >
                <span className="treepanel__result-name">{node.type === "file" ? node.name : node.name + "/"}</span>
                <span className="treepanel__result-path">{row.id}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

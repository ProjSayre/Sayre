import { useEffect, useMemo, useRef, useState } from "react";
import { FEATURE_BY_ID, NODE_BY_ID } from "../data";
import { useCanvasBus, useDemoDispatch, useDemoState } from "./state";
import { visibleTreeItems } from "./canvas/layout";
import { useContextSearch } from "./search/useFileSearch";

export type PanelMode = "tree" | "search";

/**
 * IDE-style left panel (§6.5 + design v2): `tree` mirrors the canvas with
 * disclosure chevrons, node-language glyphs, indent guides and test dots;
 * `search` hosts the context search (⌘k focuses it on desktop). Dir clicks run
 * the same reducer as canvas clicks on every tab; the panel never drills.
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
      <div className="treepanel__repo">
        <span className="treepanel__repo-name">acme/monorepo</span>
        <span className="treepanel__repo-branch">main</span>
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

  const guides = (depth: number): JSX.Element[] =>
    Array.from({ length: depth }, (_, gi) => <span key={gi} className="treepanel__guide" aria-hidden="true" />);

  return (
    <ul className="treepanel__list" role="tree" aria-label="repository tree" ref={listRef}>
      {items.map((item) => {
        if (item.kind === "ghost") {
          return (
            <li key={item.id} role="none" className="treepanel__ghost">
              {guides(item.depth)}
              <span className="treepanel__chevron-spacer" />
              <span className="treepanel__ghost-label">{item.label}</span>
            </li>
          );
        }
        const node = item.node;
        const isFolder = node.type !== "file";
        const isRoot = node.type === "root";
        const expanded = state.expandedIds.has(node.id);
        const selected = state.selectedId === node.id;
        const tests = !isFolder ? node.meta.tests : undefined;
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
              {guides(item.depth)}
              {isFolder ? (
                <span
                  className={expanded ? "treepanel__chevron is-open" : "treepanel__chevron"}
                  aria-hidden="true"
                  onClick={(e) => {
                    // IDE semantics: the chevron discloses without selecting
                    e.stopPropagation();
                    dispatch({ type: "toggleExpand", id: node.id });
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8">
                    <path d="M2.2 1.2 L5.8 4 L2.2 6.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : (
                <span className="treepanel__chevron-spacer" />
              )}
              <svg className="treepanel__glyph" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                {isFolder ? (
                  <circle cx="7" cy="7" r={isRoot ? 5 : 4.5} className={isRoot ? "treepanel__glyph-ring treepanel__glyph-ring--root" : "treepanel__glyph-ring"} />
                ) : (
                  <circle cx="7" cy="7" r="3.2" className="treepanel__glyph-dot" />
                )}
              </svg>
              <span className="treepanel__name">{isFolder ? node.name + "/" : node.name}</span>
              {tests && <span className={`treepanel__testdot treepanel__testdot--${tests.status}`} title={`tests ${tests.status === "pass" ? "passing" : "failing"}`} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SearchPane({ focusToken, onExit }: { focusToken: number; onExit: () => void }): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rows = useContextSearch(query, state.tab, 12);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => setActive(0), [query, state.tab]);

  const choose = (row: { kind: "node" | "feature"; id: string }): void => {
    if (row.kind === "feature") {
      dispatch({ type: "selectFeature", id: row.id });
      return;
    }
    dispatch({ type: "selectFileForTab", id: row.id });
    window.setTimeout(() => bus.current?.flyToNode(row.id), 30);
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
      choose(rows[active]);
    }
  };

  const placeholder = state.tab === "features" ? "search features…" : "search files…";

  return (
    <div className="treepanel__search" onKeyDown={onKeyDown}>
      <div className="treepanel__searchbox">
        <input
          ref={inputRef}
          className="treepanel__searchinput"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="panel-search-results"
          aria-activedescendant={rows[active] ? `panel-row-${active}` : undefined}
          aria-label={placeholder.replace("…", "")}
        />
        <span className="treepanel__searchhint" aria-hidden="true">
          ⌘k
        </span>
      </div>
      <div className="treepanel__results" id="panel-search-results" role="listbox">
        {rows.length === 0 ? (
          <div className="treepanel__noresults">{state.tab === "features" ? "no features match" : "no files match"}</div>
        ) : (
          rows.map((row, i) => {
            const isActive = i === active;
            if (row.kind === "feature") {
              const f = FEATURE_BY_ID.get(row.id);
              if (!f) return null;
              return (
                <div
                  key={`f-${row.id}`}
                  id={`panel-row-${i}`}
                  role="option"
                  aria-selected={isActive}
                  className={isActive ? "treepanel__result treepanel__result--feature is-active" : "treepanel__result treepanel__result--feature"}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(row)}
                >
                  <span className="treepanel__result-name">
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="treepanel__result-ring">
                      <circle cx="6" cy="6" r="4.5" fill="none" strokeWidth="1" strokeDasharray="2.5 1.8" />
                    </svg>
                    {f.name}
                  </span>
                  <span className="treepanel__result-path">
                    feature · {f.memberIds.length} files · {f.workspaces.length} workspaces
                  </span>
                </div>
              );
            }
            const node = NODE_BY_ID.get(row.id);
            if (!node) return null;
            return (
              <div
                key={row.id}
                id={`panel-row-${i}`}
                role="option"
                aria-selected={isActive}
                className={isActive ? "treepanel__result is-active" : "treepanel__result"}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(row)}
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

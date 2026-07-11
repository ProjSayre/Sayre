import { useEffect, useRef, useState } from "react";
import { FEATURE_BY_ID, NODE_BY_ID } from "../../data";
import { useCanvasBus, useDemoDispatch, useDemoState } from "../state";
import { useContextSearch } from "./useFileSearch";
import type { SearchRow } from "./useFileSearch";

export function CommandK({ onClose }: { onClose: () => void }): JSX.Element {
  const dispatch = useDemoDispatch();
  const state = useDemoState();
  const bus = useCanvasBus();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    inputRef.current?.focus();
    return () => (restoreRef.current as HTMLElement | null)?.focus?.();
  }, []);

  const rows = useContextSearch(query, state.tab, 8);

  useEffect(() => setActive(0), [query]);

  const choose = (row: SearchRow): void => {
    onClose();
    if (row.kind === "feature") {
      dispatch({ type: "selectFeature", id: row.id });
      return;
    }
    dispatch({ type: "selectFileForTab", id: row.id });
    // fly after the (re-)layout settles — each view's bus resolves the position
    window.setTimeout(() => bus.current?.flyToNode(row.id), 30);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && rows[active]) {
      e.preventDefault();
      choose(rows[active]);
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus stays in the search input (§10: focus trapped)
    }
  };

  const placeholder = state.tab === "features" ? "search features…" : "search files…";

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label={placeholder.replace("…", "")} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="cmdk__input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-results"
          aria-activedescendant={rows[active] ? `cmdk-row-${active}` : undefined}
        />
        <div className="cmdk__results" id="cmdk-results" role="listbox">
          {rows.length === 0 ? (
            <div className="cmdk__empty">{state.tab === "features" ? "no features match" : "no files match"}</div>
          ) : (
            rows.map((row, i) => {
              if (row.kind === "feature") {
                const f = FEATURE_BY_ID.get(row.id);
                if (!f) return null;
                return (
                  <div
                    key={`f-${row.id}`}
                    id={`cmdk-row-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? "cmdk__row is-active" : "cmdk__row"}
                    onPointerMove={() => setActive(i)}
                    onClick={() => choose(row)}
                  >
                    <span className="cmdk__name">{highlight(f.name, row.positions, 0)}</span>
                    <span className="cmdk__path">
                      feature · {f.memberIds.length} files · {f.workspaces.length} workspaces
                    </span>
                  </div>
                );
              }
              const node = NODE_BY_ID.get(row.id);
              if (!node) return null;
              const filenameStart = row.id.lastIndexOf("/") + 1;
              const name = node.type === "file" ? node.name : node.name + "/";
              return (
                <div
                  key={row.id}
                  id={`cmdk-row-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "cmdk__row is-active" : "cmdk__row"}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(row)}
                >
                  <span className="cmdk__name">{highlight(name, row.positions, filenameStart)}</span>
                  <span className="cmdk__path">{highlight(row.id, row.positions, 0)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, positions: number[], offset: number): JSX.Element[] {
  const set = new Set(positions.map((p) => p - offset).filter((p) => p >= 0 && p < text.length));
  const out: JSX.Element[] = [];
  let run = "";
  let runMatched: boolean | null = null;
  let key = 0;
  const flush = (): void => {
    if (run === "") return;
    out.push(
      runMatched ? (
        <mark key={key++} className="cmdk__match">
          {run}
        </mark>
      ) : (
        <span key={key++}>{run}</span>
      ),
    );
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (runMatched === null || m !== runMatched) {
      flush();
      runMatched = m;
    }
    run += text[i];
  }
  flush();
  return out;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { CHILDREN, NODE_BY_ID, ROOT_ID, ancestorIds } from "../../data";
import type { RepoNode } from "../../data";
import { useCanvasBus, useDemoDispatch, useDemoState, useZoomStore } from "../state";
import type { Bounds } from "./layout";
import { labelWidth, useFontGate } from "./measure";
import { rollupScope, widthForCount } from "./rollup";
import { useCamera } from "./useCamera";

interface Props {
  interactive?: boolean;
  onUserInteract?: () => void;
}

interface Placed {
  node: RepoNode;
  x: number;
  y: number;
}

export function RelationsView({ interactive = true, onUserInteract }: Props): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const zoomStore = useZoomStore();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { canMeasure, fontsVersion } = useFontGate();
  const [kbNav, setKbNav] = useState(false);

  const scopeId = state.relationsScope;
  const scope = NODE_BY_ID.get(scopeId);
  const kids = useMemo(() => CHILDREN.get(scopeId) ?? [], [scopeId]);

  const placed = useMemo<Placed[]>(() => {
    const n = kids.length;
    if (n === 0) return [];
    if (n === 1) return [{ node: kids[0], x: 0, y: 0 }];
    const r = Math.max(130, 15 * n);
    return kids.map((node, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return { node, x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
  }, [kids]);

  const posById = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const p of placed) m.set(p.node.id, p);
    return m;
  }, [placed]);

  const bounds = useMemo<Bounds | null>(() => {
    if (!canMeasure || placed.length === 0) return { minX: -160, minY: -120, maxX: 160, maxY: 120 };
    let b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of placed) {
      const label = p.node.type === "file" ? p.node.name : p.node.name + "/";
      const fs = p.node.type === "file" ? 11 : 11.5;
      const right = p.x + 8 + 6 + labelWidth(label, fs);
      b = {
        minX: Math.min(b.minX, p.x - 10),
        minY: Math.min(b.minY, p.y - 14),
        maxX: Math.max(b.maxX, right),
        maxY: Math.max(b.maxY, p.y + 14),
      };
    }
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, canMeasure, fontsVersion]);

  const aggregates = useMemo(
    () => rollupScope(scopeId, state.edgeKinds),
    [scopeId, state.edgeKinds],
  );

  const camera = useCamera({
    svgRef,
    bounds,
    fitKey: `relations:${scopeId}:${fontsVersion}:${canMeasure}`,
    interactive,
    zoomStore,
    onUserInteract,
  });

  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const posRef = useRef(posById);
  posRef.current = posById;

  useEffect(() => {
    if (!interactive) return;
    bus.current = {
      flyToNode: (id) => {
        const p = posRef.current.get(id);
        if (p) cameraRef.current.flyTo(p.x, p.y);
      },
      fit: () => cameraRef.current.fit(true),
      zoomAt: (f) => cameraRef.current.zoomAt(f),
      nodeScreenPos: (id) => {
        const p = posRef.current.get(id);
        const rect = svgRef.current?.getBoundingClientRect();
        if (!p || !rect) return null;
        const s = cameraRef.current.screenFromWorld(p.x, p.y);
        return { x: rect.left + s.x, y: rect.top + s.y };
      },
    };
    return () => {
      bus.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  // arriving on this tab with an in-scope selection: center it once
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (!interactive || focusedOnceRef.current) return;
    const id = state.selectedId;
    if (!id || !posById.has(id)) return;
    focusedOnceRef.current = true;
    const t = window.setTimeout(() => {
      const p = posRef.current.get(id);
      if (p) cameraRef.current.flyTo(p.x, p.y, { duration: 500 });
    }, 380);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posById]);

  const selectedInScope = state.selectedId !== null && posById.has(state.selectedId);

  const litEdge = (e: { fromId: string; toId: string }): "out" | "in" | null => {
    if (!selectedInScope || !state.selectedId) return null;
    if (e.fromId === state.selectedId) return "out";
    if (e.toId === state.selectedId) return "in";
    return null;
  };

  // counterpart node lighting: outgoing targets accent-text, incoming sources --text
  const counterpartRole = (id: string): "target" | "source" | null => {
    if (!selectedInScope || !state.selectedId || id === state.selectedId) return null;
    for (const e of aggregates) {
      if (e.fromId === state.selectedId && e.toId === id) return "target";
      if (e.toId === state.selectedId && e.fromId === id) return "source";
    }
    return null;
  };

  const clickNode = (node: RepoNode): void => {
    setKbNav(false);
    if (node.type !== "file" && state.selectedId === node.id) {
      dispatch({ type: "drill", id: node.id });
      return;
    }
    dispatch({ type: "selectNode", id: node.id });
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!interactive) return;
    if (e.key === "Backspace") {
      e.preventDefault();
      dispatch({ type: "scopeUp" });
      return;
    }
    if (e.key === "Enter") {
      const sel = state.selectedId ? NODE_BY_ID.get(state.selectedId) : null;
      if (sel && sel.type !== "file" && posById.has(sel.id)) {
        e.preventDefault();
        dispatch({ type: "drill", id: sel.id });
      }
      return;
    }
    if (!e.key.startsWith("Arrow") || kids.length === 0) return;
    e.preventDefault();
    setKbNav(true);
    const dirNext = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const i = kids.findIndex((k) => k.id === state.selectedId);
    const next = i === -1 ? kids[0] : kids[(i + dirNext + kids.length) % kids.length];
    dispatch({ type: "selectNode", id: next.id });
  };

  const crumbs = scope ? [...ancestorIds(scopeId), scopeId] : [ROOT_ID];

  const kindLabel = [state.edgeKinds.imports ? "imports" : null, state.edgeKinds.calls ? "calls" : null]
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className="demo-canvas"
        tabIndex={interactive ? 0 : -1}
        role="application"
        aria-label={`relations canvas, scope ${scope?.name ?? "acme"} — arrows cycle nodes, enter drills into a selected directory, backspace goes up`}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (!interactive) return;
          if (camera.shouldIgnoreClick()) return;
          if ((e.target as Element).closest("[data-node]")) return;
          dispatch({ type: "selectNode", id: null });
        }}
      >
        <g transform={camera.transform}>
          <g key={scopeId} className="scope-fade">
            {/* aggregate edges */}
            {aggregates.map((e) => {
              const a = posById.get(e.fromId);
              const b = posById.get(e.toId);
              if (!a || !b) return null;
              const lit = litEdge(e);
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              return (
                <g key={`${e.fromId}→${e.toId}`}>
                  <line
                    className={
                      lit === "out"
                        ? "rel-edge rel-edge--out"
                        : lit === "in"
                          ? "rel-edge rel-edge--in"
                          : "rel-edge"
                    }
                    strokeWidth={lit ? undefined : widthForCount(e.count)}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                  />
                  {lit && (
                    <text className="rel-count" x={mx + 5} y={my - 5}>
                      {e.count}
                    </text>
                  )}
                </g>
              );
            })}

            {/* nodes */}
            {placed.map((p) => {
              const node = p.node;
              const isFile = node.type === "file";
              const isSelected = state.selectedId === node.id;
              const role = counterpartRole(node.id);
              const r = isFile ? (isSelected ? 5 : 4.5) : isSelected ? 8 : 6.5;
              const label = isFile ? node.name : node.name + "/";
              const fs = isFile ? 11 : 11.5;
              return (
                <g
                  key={node.id}
                  data-node="true"
                  className={[
                    "tree-node",
                    isFile ? "tree-node--file" : "tree-node--folder",
                    isSelected ? "is-selected" : "",
                    role === "target" ? "is-counterpart-out" : "",
                    role === "source" ? "is-counterpart-in" : "",
                  ].join(" ")}
                  transform={`translate(${p.x}, ${p.y})`}
                  role="button"
                  tabIndex={-1}
                  aria-label={
                    isFile
                      ? `file ${node.name}${isSelected ? ", selected" : ""}`
                      : `folder ${node.name}${isSelected ? ", selected — click again to drill in" : ""}`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!interactive) return;
                    if (camera.shouldIgnoreClick()) return;
                    clickNode(node);
                  }}
                >
                  {isFile ? <circle className="node-dot" r={r} /> : <circle className="node-ring" r={r} />}
                  <text className="canvas-label" x={r + 6} y={fs * 0.35} fontSize={fs}>
                    {label}
                  </text>
                  {kbNav && isSelected && <circle className="kb-focus-ring" r={r + 5} />}
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* breadcrumb — floats top-left (§7.5) */}
      <nav className="rel-breadcrumb" aria-label="relations scope">
        {crumbs.map((id, i) => {
          const node = NODE_BY_ID.get(id);
          if (!node) return null;
          const isLast = i === crumbs.length - 1;
          return (
            <span key={id}>
              {i > 0 && <span className="rel-breadcrumb__sep"> › </span>}
              {isLast ? (
                <span className="rel-breadcrumb__current">{node.name}/</span>
              ) : (
                <button
                  className="rel-breadcrumb__link"
                  onClick={() => dispatch({ type: "setScope", id })}
                  disabled={!interactive}
                >
                  {node.name}/
                </button>
              )}
            </span>
          );
        })}
      </nav>

      {/* edge-kind filter — floats top-right */}
      <div className="rel-filter" role="group" aria-label="edge kinds">
        {(["imports", "calls"] as const).map((kind) => (
          <button
            key={kind}
            className={state.edgeKinds[kind] ? "rel-filter__toggle is-active" : "rel-filter__toggle"}
            aria-pressed={state.edgeKinds[kind]}
            onClick={() => dispatch({ type: "toggleEdgeKind", kind })}
            disabled={!interactive}
          >
            {kind}
          </button>
        ))}
      </div>

      {/* legend — floats bottom-right */}
      <div className="rel-legend" aria-hidden="true">
        ── outgoing · ─ ─ incoming
      </div>
      {kindLabel === "" && <span className="visually-hidden">no edge kinds active</span>}
    </div>
  );
}

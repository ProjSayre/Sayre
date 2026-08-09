import { useEffect, useMemo, useRef, useState } from "react";
import { CHILDREN, NODE_BY_ID } from "../../data";
import type { RepoNode } from "../../data";
import { useCanvasBus, useDemoDispatch, useDemoState, useZoomStore } from "../state";
import { itemFontSize, itemLabel, layoutFiletree, litSets, nodeRadius } from "./layout";
import type { TreeItem } from "./layout";
import { useFontGate } from "./measure";
import { useAnimatedPositions } from "./useAnimatedPositions";
import { useCamera } from "./useCamera";

interface Props {
  interactive?: boolean;
  onUserInteract?: () => void;
}

export function FiletreeView({ interactive = true, onUserInteract }: Props): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const zoomStore = useZoomStore();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { canMeasure, fontsVersion } = useFontGate();
  const [kbNav, setKbNav] = useState(false);

  const layout = useMemo(
    () => (canMeasure ? layoutFiletree(state.expandedIds) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.expandedIds, canMeasure, fontsVersion],
  );

  const positions = useAnimatedPositions(
    layout?.positions ?? new Map(),
    (id) => {
      if (id.endsWith("//ghost")) return id.slice(0, -"//ghost".length);
      return NODE_BY_ID.get(id)?.parentId ?? null;
    },
  );

  const camera = useCamera({
    svgRef,
    bounds: layout?.bounds ?? null,
    fitKey: `filetree:${fontsVersion}:${canMeasure}`,
    interactive,
    zoomStore,
    onUserInteract,
  });

  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // register the imperative bus for panel / search / tour / global keys
  useEffect(() => {
    if (!interactive) return;
    bus.current = {
      flyToNode: (id) => {
        const pos = layoutRef.current?.positions.get(id);
        if (pos) cameraRef.current.flyTo(pos.x, pos.y);
      },
      fit: () => cameraRef.current.fit(true),
      zoomAt: (f) => cameraRef.current.zoomAt(f),
      nodeScreenPos: (id) => {
        const pos = layoutRef.current?.positions.get(id);
        const rect = svgRef.current?.getBoundingClientRect();
        if (!pos || !rect) return null;
        const s = cameraRef.current.screenFromWorld(pos.x, pos.y);
        return { x: rect.left + s.x, y: rect.top + s.y };
      },
    };
    return () => {
      bus.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  const lit = useMemo(() => litSets(state.selectedId), [state.selectedId]);

  // arriving on this tab with a selection: focus it after the fit settles
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (!interactive || focusedOnceRef.current || !canMeasure) return;
    const id = state.selectedId;
    if (!id) return;
    focusedOnceRef.current = true;
    const t = window.setTimeout(() => {
      const pos = layoutRef.current?.positions.get(id);
      if (pos) cameraRef.current.flyTo(pos.x, pos.y, { duration: 500, k: Math.max(cameraRef.current.cam.k, 0.85) });
    }, 380);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canMeasure]);

  if (!layout) {
    return (
      <div className="canvas-wrap">
        <svg ref={svgRef} className="demo-canvas" aria-hidden="true" />
      </div>
    );
  }

  const onNodeClick = (item: TreeItem): void => {
    if (item.kind === "ghost") return;
    setKbNav(false);
    dispatch({ type: "clickTreeNode", id: item.id });
  };

  const keyboardSelect = (id: string): void => {
    dispatch({ type: "selectNode", id });
    setKbNav(true);
    const pos = layoutRef.current?.positions.get(id);
    if (pos && !cameraRef.current.inView(pos.x, pos.y)) cameraRef.current.flyTo(pos.x, pos.y);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!interactive) return;
    const sel = state.selectedId ? NODE_BY_ID.get(state.selectedId) : null;
    const visible = (id: string): boolean => layoutRef.current?.positions.has(id) ?? false;

    if (e.key === "Enter") {
      if (sel && sel.type !== "file") {
        dispatch({ type: "toggleExpand", id: sel.id });
        e.preventDefault();
      }
      return;
    }
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    setKbNav(true);
    if (!sel) {
      keyboardSelect("acme");
      return;
    }
    if (e.key === "ArrowUp") {
      if (sel.parentId) keyboardSelect(sel.parentId);
      return;
    }
    if (e.key === "ArrowDown") {
      const kids = (CHILDREN.get(sel.id) ?? []).filter((c) => visible(c.id));
      if (kids.length > 0) keyboardSelect(kids[0].id);
      return;
    }
    if (sel.parentId) {
      const siblings = (CHILDREN.get(sel.parentId) ?? []).filter((c) => visible(c.id));
      const i = siblings.findIndex((s) => s.id === sel.id);
      if (i === -1) return;
      const next = e.key === "ArrowLeft" ? siblings[i - 1] : e.key === "ArrowRight" ? siblings[i + 1] : undefined;
      if (next) keyboardSelect(next.id);
    }
  };

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className="demo-canvas"
        tabIndex={interactive ? 0 : -1}
        role="application"
        aria-label="filetree canvas — arrow keys move between nodes, enter toggles folders"
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (!interactive) return;
          if (camera.shouldIgnoreClick()) return;
          if ((e.target as Element).closest("[data-node]")) return;
          dispatch({ type: "selectNode", id: null });
        }}
      >
        <g transform={camera.transform}>
          <g className="scope-fade">
          {/* edges (back) */}
          {layout.items.map((item) => {
            const pid = item.parentId;
            if (pid === null) return null;
            const p = positions.get(pid);
            const c = positions.get(item.id);
            if (!p || !c) return null;
            if (item.kind === "ghost") {
              return (
                <line key={item.id} className="tree-edge tree-edge--ghost" x1={p.x} y1={p.y} x2={c.x} y2={c.y} />
              );
            }
            const isLit = lit.edges.has(`${pid}→${item.id}`);
            return (
              <line
                key={item.id}
                className={isLit ? "tree-edge tree-edge--lit" : "tree-edge"}
                x1={p.x}
                y1={p.y}
                x2={c.x}
                y2={c.y}
              />
            );
          })}

          {/* nodes + labels */}
          {layout.items.map((item) => {
            const pos = positions.get(item.id);
            if (!pos) return null;
            if (item.kind === "ghost") {
              return (
                <text key={item.id} className="canvas-label canvas-label--ghost" x={pos.x + 6} y={pos.y + 3.5}>
                  {item.label}
                </text>
              );
            }
            const node = item.node;
            const isSelected = state.selectedId === node.id;
            const onPath = !isSelected && lit.nodes.has(node.id);
            const r = nodeRadius(item, isSelected);
            const isFile = node.type === "file";
            const label = itemLabel(item);
            const fs = itemFontSize(item);
            const badge = isFile && state.layers.tests && node.meta.tests;
            return (
              <g
                key={item.id}
                data-node="true"
                className={[
                  "tree-node",
                  isFile ? "tree-node--file" : "tree-node--folder",
                  isSelected ? "is-selected" : "",
                  onPath ? "is-onpath" : "",
                ].join(" ")}
                transform={`translate(${pos.x}, ${pos.y})`}
                role="button"
                tabIndex={-1}
                aria-label={nodeAria(node, isSelected)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!interactive) return;
                  if (camera.shouldIgnoreClick()) return;
                  onNodeClick(item);
                }}
              >
                {isFile ? (
                  <circle className="node-dot" r={r} />
                ) : (
                  <circle className={node.type === "root" ? "node-ring node-ring--root" : "node-ring"} r={r} />
                )}
                {badge && (
                  <circle
                    className={node.meta.tests!.status === "pass" ? "test-badge test-badge--pass" : "test-badge test-badge--fail"}
                    cx={r + 3}
                    cy={-r - 3}
                    r={2}
                  />
                )}
                <text className="canvas-label" x={r + 6} y={fs * 0.32} fontSize={fs}>
                  {label}
                </text>
                {kbNav && isSelected && <circle className="kb-focus-ring" r={r + 5} />}
              </g>
            );
          })}
          </g>
        </g>
      </svg>
    </div>
  );
}

function nodeAria(node: RepoNode, selected: boolean): string {
  const sel = selected ? ", selected" : "";
  if (node.type === "file") return `file ${node.name}${sel}`;
  const count = node.fileCount !== undefined ? `, ${node.fileCount} files` : "";
  return `folder ${node.name}${count}${sel}`;
}

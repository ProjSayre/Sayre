import { useEffect, useMemo, useRef, useState } from "react";
import { FEATURES, NODE_BY_ID, featureDirCount, sharedMembers } from "../../data";
import type { Feature } from "../../data";
import { useCanvasBus, useDemoDispatch, useDemoState, useZoomStore } from "../state";
import type { Bounds } from "./layout";
import { labelWidth, useFontGate } from "./measure";
import { useCamera } from "./useCamera";

interface Props {
  interactive?: boolean;
  onUserInteract?: () => void;
}

interface PlacedFeature {
  feature: Feature;
  x: number;
  y: number;
  r: number;
  dirs: { dirId: string; x: number; y: number; files: { fileId: string; x: number; y: number }[] }[];
}

function featureRadius(f: Feature): number {
  return Math.min(62, Math.max(40, 34 + 7 * featureDirCount(f)));
}

/** deterministic 2×2 layout (§7.4): checkout TL, search TR, auth BL, design-system BR */
function placeFeatures(): PlacedFeature[] {
  const order = ["checkout", "search", "auth", "design-system"];
  const feats = order.map((id) => FEATURES.find((f) => f.id === id)!).filter(Boolean);
  const radii = feats.map(featureRadius);

  const labelW = (f: Feature): number =>
    Math.max(
      labelWidth(f.name, 11.5),
      labelWidth(`${f.memberIds.length} files · ${f.workspaces.length} workspaces`, 10.5),
    );

  const leftCol = [feats[0], feats[2]];
  const widestLeftLabel = Math.max(...leftCol.map(labelW));
  const colGap = Math.max(48, widestLeftLabel + 36);
  const rowGap = 48;

  const maxRLeft = Math.max(radii[0], radii[2]);
  const maxRRight = Math.max(radii[1], radii[3]);
  const maxRTop = Math.max(radii[0], radii[1]);
  const maxRBottom = Math.max(radii[2], radii[3]);

  const colDist = maxRLeft + colGap + maxRRight;
  const rowDist = maxRTop + rowGap + maxRBottom;

  const centers = [
    { x: -colDist / 2, y: -rowDist / 2 },
    { x: colDist / 2, y: -rowDist / 2 },
    { x: -colDist / 2, y: rowDist / 2 },
    { x: colDist / 2, y: rowDist / 2 },
  ];

  return feats.map((feature, i) => {
    const r = radii[i];
    const byDir = new Map<string, string[]>();
    for (const m of feature.memberIds) {
      const pid = NODE_BY_ID.get(m)?.parentId ?? "";
      const list = byDir.get(pid) ?? [];
      list.push(m);
      byDir.set(pid, list);
    }
    const dirIds = [...byDir.keys()].sort();
    const dirs = dirIds.map((dirId, di) => {
      const angle = -Math.PI / 2 + (di * 2 * Math.PI) / dirIds.length;
      const dx = Math.cos(angle) * 0.55 * r;
      const dy = Math.sin(angle) * 0.55 * r;
      const files = (byDir.get(dirId) ?? []).sort().map((fileId, fi) => {
        const fa = angle + Math.PI / 2 + (fi * 2 * Math.PI) / 9;
        return { fileId, x: dx + Math.cos(fa) * 12.5, y: dy + Math.sin(fa) * 12.5 };
      });
      return { dirId, x: dx, y: dy, files };
    });
    return { feature, x: centers[i].x, y: centers[i].y, r, dirs };
  });
}

export function FeaturesView({ interactive = true, onUserInteract }: Props): JSX.Element {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const bus = useCanvasBus();
  const zoomStore = useZoomStore();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { canMeasure, fontsVersion } = useFontGate();
  const [flyout, setFlyout] = useState<{ featureId: string; dirId: string } | null>(null);

  const placed = useMemo(
    () => (canMeasure ? placeFeatures() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canMeasure, fontsVersion],
  );

  const bounds = useMemo<Bounds | null>(() => {
    if (placed.length === 0) return null;
    let b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of placed) {
      const lw = Math.max(
        labelWidth(p.feature.name, 11.5),
        labelWidth(`${p.feature.memberIds.length} files · ${p.feature.workspaces.length} workspaces`, 10.5),
      );
      b = {
        minX: Math.min(b.minX, p.x - p.r - 6),
        minY: Math.min(b.minY, p.y - p.r - 6),
        maxX: Math.max(b.maxX, p.x + p.r + 10 + lw),
        maxY: Math.max(b.maxY, p.y + p.r + 6),
      };
    }
    return b;
  }, [placed]);

  const camera = useCamera({
    svgRef,
    bounds,
    fitKey: `features:${fontsVersion}:${canMeasure}`,
    interactive,
    zoomStore,
    onUserInteract,
  });

  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const placedRef = useRef(placed);
  placedRef.current = placed;

  useEffect(() => {
    if (!interactive) return;
    bus.current = {
      flyToNode: (id) => {
        const holder = placedRef.current.find((p) => p.feature.memberIds.includes(id));
        if (holder) cameraRef.current.flyTo(holder.x, holder.y);
      },
      fit: () => cameraRef.current.fit(true),
      zoomAt: (f) => cameraRef.current.zoomAt(f),
      nodeScreenPos: (id) => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const asFeature = placedRef.current.find((p) => p.feature.id === id);
        if (asFeature) {
          const s = cameraRef.current.screenFromWorld(asFeature.x, asFeature.y);
          return { x: rect.left + s.x, y: rect.top + s.y };
        }
        for (const p of placedRef.current) {
          for (const d of p.dirs) {
            const fd = d.files.find((f) => f.fileId === id);
            if (fd) {
              const s = cameraRef.current.screenFromWorld(p.x + fd.x, p.y + fd.y);
              return { x: rect.left + s.x, y: rect.top + s.y };
            }
          }
        }
        return null;
      },
    };
    return () => {
      bus.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  // one flyout at a time; Esc or outside click closes (§7.4)
  useEffect(() => {
    if (!flyout) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFlyout(null);
    };
    const onDown = (e: PointerEvent): void => {
      if (!(e.target as Element).closest(".feature-flyout")) setFlyout(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [flyout]);

  // arriving on this tab with a selected member file: focus its feature ring
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (!interactive || focusedOnceRef.current || placed.length === 0) return;
    const targetId = state.selectedFeatureId ?? placed.find((p) => state.selectedId && p.feature.memberIds.includes(state.selectedId))?.feature.id;
    if (!targetId) return;
    focusedOnceRef.current = true;
    const t = window.setTimeout(() => {
      const p = placedRef.current.find((f) => f.feature.id === targetId);
      if (p) cameraRef.current.flyTo(p.x, p.y, { duration: 500 });
    }, 380);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed.length > 0]);

  // shared-member edges between feature pairs
  const shared = useMemo(() => {
    const out: { a: PlacedFeature; b: PlacedFeature; files: string[] }[] = [];
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const files = sharedMembers(placed[i].feature, placed[j].feature);
        if (files.length > 0) out.push({ a: placed[i], b: placed[j], files });
      }
    }
    return out;
  }, [placed]);

  const flyoutPlaced = flyout ? placed.find((p) => p.feature.id === flyout.featureId) : null;
  const flyoutDir = flyoutPlaced?.dirs.find((d) => d.dirId === flyout?.dirId) ?? null;
  const flyoutScreen =
    flyoutPlaced && flyoutDir
      ? camera.screenFromWorld(flyoutPlaced.x + flyoutDir.x, flyoutPlaced.y + flyoutDir.y)
      : null;
  const flyoutFlip = flyoutScreen !== null && flyoutScreen.x > camera.size.w - 280;

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        className="demo-canvas"
        tabIndex={interactive ? 0 : -1}
        role="application"
        aria-label="features canvas — four feature clusters; bundled glyphs expand to file paths"
        onClick={(e) => {
          if (!interactive) return;
          if (camera.shouldIgnoreClick()) return;
          if ((e.target as Element).closest("[data-node]")) return;
          dispatch({ type: "selectNode", id: null });
        }}
      >
        <g transform={camera.transform}>
          <g className="scope-fade">
          {/* shared-member edges (behind rings) */}
          {shared.map(({ a, b }) => {
            const lit =
              state.selectedFeatureId === a.feature.id || state.selectedFeatureId === b.feature.id;
            return (
              <line
                key={`${a.feature.id}~${b.feature.id}`}
                className={lit ? "feature-shared-edge is-lit" : "feature-shared-edge"}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}

          {placed.map((p) => {
            const isSelected = state.selectedFeatureId === p.feature.id;
            const hasSelectedMember =
              state.selectedId !== null && p.feature.memberIds.includes(state.selectedId);
            const isOpen = isSelected || hasSelectedMember;
            return (
              <g
                key={p.feature.id}
                transform={`translate(${p.x}, ${p.y})`}
                className={isOpen ? "feature-group is-open" : "feature-group"}
              >
                {/* ring + interior = feature selection target */}
                <g
                  data-node="true"
                  className={[
                    "feature-node",
                    isSelected ? "is-selected" : "",
                    hasSelectedMember ? "has-selected-member" : "",
                  ].join(" ")}
                  role="button"
                  tabIndex={interactive ? 0 : -1}
                  aria-label={`feature ${p.feature.name}, ${p.feature.memberIds.length} files across ${p.feature.workspaces.length} workspaces${isSelected ? ", selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!interactive) return;
                    if (camera.shouldIgnoreClick()) return;
                    dispatch({ type: "selectFeature", id: p.feature.id });
                  }}
                  onKeyDown={(e) => {
                    if (interactive && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      dispatch({ type: "selectFeature", id: p.feature.id });
                    }
                  }}
                >
                  <circle className="feature-ring" r={isOpen ? p.r * 1.04 : p.r} />
                  <text className="feature-name" x={p.r + 10} y={-1}>
                    {p.feature.name}
                  </text>
                  <text className="feature-sub" x={p.r + 10} y={13}>
                    {p.feature.memberIds.length} files · {p.feature.workspaces.length} workspaces
                  </text>
                </g>

                {/* bundled glyphs: dirs (hollow) + their files (filled) */}
                {p.dirs.map((d) => {
                  const dirNode = NODE_BY_ID.get(d.dirId);
                  const dirPath = dirNode ? d.dirId + "/" : d.dirId;
                  const parts = d.dirId.split("/");
                  const last = parts[parts.length - 1];
                  // generic tails like "src" are ambiguous — prefix the parent
                  const shortName = (last === "src" && parts.length > 1 ? `${parts[parts.length - 2]}/src` : last) + "/";
                  return (
                    <g key={d.dirId}>
                      <g
                        data-node="true"
                        className="bundle-dir"
                        role="button"
                        tabIndex={interactive ? 0 : -1}
                        aria-label={dirPath}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!interactive) return;
                          if (camera.shouldIgnoreClick()) return;
                          setFlyout(
                            flyout?.dirId === d.dirId && flyout?.featureId === p.feature.id
                              ? null
                              : { featureId: p.feature.id, dirId: d.dirId },
                          );
                        }}
                        onKeyDown={(e) => {
                          if (interactive && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            e.stopPropagation();
                            setFlyout({ featureId: p.feature.id, dirId: d.dirId });
                          }
                        }}
                      >
                        <circle className="bundle-dir__ring" cx={d.x} cy={d.y} r={6} />
                        <text className="bundle-dir__label" x={d.x + 10} y={d.y + 3}>
                          {shortName}
                        </text>
                      </g>
                      {d.files.map((fd) => {
                        const fileSelected = state.selectedId === fd.fileId;
                        return (
                          <g
                            key={fd.fileId}
                            data-node="true"
                            className={fileSelected ? "bundle-file is-selected" : "bundle-file"}
                            role="button"
                            tabIndex={interactive ? 0 : -1}
                            aria-label={fd.fileId}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!interactive) return;
                              if (camera.shouldIgnoreClick()) return;
                              dispatch({ type: "selectFileForTab", id: fd.fileId });
                            }}
                            onKeyDown={(e) => {
                              if (interactive && (e.key === "Enter" || e.key === " ")) {
                                e.preventDefault();
                                e.stopPropagation();
                                dispatch({ type: "selectFileForTab", id: fd.fileId });
                              }
                            }}
                          >
                            <circle className="bundle-file__dot" cx={fd.x} cy={fd.y} r={3} />
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            );
          })}
          </g>
        </g>
      </svg>

      {/* path-expansion flyout (§7.4) */}
      {flyout && flyoutPlaced && flyoutDir && flyoutScreen && (
        <div
          className="feature-flyout"
          role="dialog"
          aria-label={`files in ${flyout.dirId}`}
          style={{
            left: flyoutFlip ? undefined : flyoutScreen.x + 12,
            right: flyoutFlip ? camera.size.w - flyoutScreen.x + 12 : undefined,
            top: Math.max(12, Math.min(flyoutScreen.y - 16, camera.size.h - 180)),
          }}
        >
          <div className="feature-flyout__path">{flyout.dirId}/</div>
          {flyoutDir.files.map((fd) => (
            <button
              key={fd.fileId}
              className="feature-flyout__row"
              onClick={() => {
                dispatch({ type: "selectFileForTab", id: fd.fileId });
                setFlyout(null);
              }}
            >
              {NODE_BY_ID.get(fd.fileId)?.name ?? fd.fileId}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

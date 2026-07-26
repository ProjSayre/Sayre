'use client';

import { useEffect, useRef, useState } from 'react';
import { createNodeBorderProgram } from '@sigma/node-border';
import Sigma from 'sigma';
import type { AuthorizedCanvasNode, AuthorizedCanvasPayload } from '../lib/scaleGraph';
import { toPresentationGraph } from '../lib/scaleGraph';
import type { CanvasCommand } from '../workspace/rendererRegistry';

export interface SigmaBoundary {
  id: string;
  label: string;
  memberIds: string[];
}

interface SigmaCanvasProps {
  payload: AuthorizedCanvasPayload;
  onSelect: (node: AuthorizedCanvasNode) => void;
  boundaries?: readonly SigmaBoundary[];
  onSelectBoundary?: (boundaryId: string) => void;
  command?: CanvasCommand | null;
  search?: string;
  selectedNodeId?: string | null;
}

interface ViewportBoundary extends SigmaBoundary {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EMPTY_BOUNDARIES: readonly SigmaBoundary[] = [];
const SayreNodeProgram = createNodeBorderProgram({
  borders: [
    {
      size: { value: 1.35, mode: 'pixels' },
      color: { attribute: 'borderColor', defaultValue: '#77776e' },
    },
    { size: { fill: true }, color: { attribute: 'color' } },
  ],
});

function activateBoundary(
  event: React.KeyboardEvent<SVGGElement>,
  boundaryId: string,
  onSelectBoundary: ((boundaryId: string) => void) | undefined,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onSelectBoundary?.(boundaryId);
}

export function SigmaCanvas({
  payload,
  onSelect,
  boundaries = EMPTY_BOUNDARIES,
  onSelectBoundary,
  command = null,
  search = '',
  selectedNodeId = null,
}: SigmaCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const onSelectRef = useRef(onSelect);
  const previousSearchRef = useRef('');
  const [viewportBoundaries, setViewportBoundaries] = useState<ViewportBoundary[]>([]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (containerRef.current === null) return undefined;

    const graph = toPresentationGraph(payload);
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: false,
      defaultNodeType: 'border',
      nodeProgramClasses: { border: SayreNodeProgram },
      defaultEdgeColor: '#41423b',
      defaultNodeColor: '#77776e',
      labelColor: { color: '#b9b9af' },
      labelDensity: 0.14,
      labelFont:
        '"Fragment Mono", ui-monospace, SFMono-Regular, Consolas, monospace',
      labelGridCellSize: 96,
      labelRenderedSizeThreshold: 3.4,
      labelSize: 11,
      labelWeight: '400',
      minEdgeThickness: 0.65,
      renderEdgeLabels: false,
      stagePadding: 42,
      zIndex: true,
    });
    rendererRef.current = renderer;

    renderer.on('clickNode', ({ node }) => {
      const match = payload.nodes.find((candidate) => candidate.id === node);
      if (match !== undefined) onSelectRef.current(match);
    });

    const nodeById = new Map(payload.nodes.map((node) => [node.id, node]));
    const updateBoundaries = () => {
      setViewportBoundaries(
        boundaries.flatMap<ViewportBoundary>((boundary) => {
          const points = boundary.memberIds.flatMap((memberId) => {
            const node = nodeById.get(memberId);
            return node === undefined
              ? []
              : [renderer.graphToViewport({ x: node.x, y: node.y })];
          });
          if (points.length === 0) return [];
          const minX = Math.min(...points.map(({ x }) => x));
          const minY = Math.min(...points.map(({ y }) => y));
          const maxX = Math.max(...points.map(({ x }) => x));
          const maxY = Math.max(...points.map(({ y }) => y));
          const padding = 30;
          return [{
            ...boundary,
            x: minX - padding,
            y: minY - padding,
            width: maxX - minX + padding * 2,
            height: maxY - minY + padding * 2,
          }];
        }),
      );
    };

    const camera = renderer.getCamera();
    const frame = window.requestAnimationFrame(updateBoundaries);
    camera.on('updated', updateBoundaries);
    renderer.on('resize', updateBoundaries);

    return () => {
      window.cancelAnimationFrame(frame);
      camera.off('updated', updateBoundaries);
      renderer.off('resize', updateBoundaries);
      renderer.kill();
      rendererRef.current = null;
    };
  }, [boundaries, payload]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null) return;

    const normalizedSearch = search.trim().toLowerCase();
    const matchingNodes = payload.nodes.filter(
      (node) =>
        normalizedSearch.length === 0 ||
        node.label.toLowerCase().includes(normalizedSearch) ||
        node.path.toLowerCase().includes(normalizedSearch),
    );
    const matchingNodeIds = new Set(matchingNodes.map((node) => node.id));
    const edgeById = new Map(payload.edges.map((edge) => [edge.id, edge]));
    const containsParent = new Map(
      payload.edges
        .filter((edge) => edge.relationship === 'CONTAINS')
        .map((edge) => [edge.target, edge] as const),
    );
    const selectedPathNodes = new Set<string>();
    const selectedPathEdges = new Set<string>();
    let pathCursor = selectedNodeId;
    while (
      pathCursor !== null &&
      !selectedPathNodes.has(pathCursor)
    ) {
      selectedPathNodes.add(pathCursor);
      const parentEdge = containsParent.get(pathCursor);
      if (parentEdge === undefined) break;
      selectedPathEdges.add(parentEdge.id);
      pathCursor = parentEdge.source;
    }
    const camera = renderer.getCamera();
    let importsVisible =
      normalizedSearch.length > 0 || camera.ratio < 0.62;

    renderer.setSetting('nodeReducer', (node, data) => ({
      ...data,
      hidden: !matchingNodeIds.has(node),
      label: data.label,
      borderColor:
        node === selectedNodeId
          ? '#7fb18e'
          : selectedPathNodes.has(node)
            ? '#4f7f5d'
            : data.borderColor,
      color:
        node === selectedNodeId
          ? data.kind === 'Folder'
            ? '#131412'
            : '#7fb18e'
          : data.color,
      size:
        node === selectedNodeId
          ? data.size * 1.45
          : selectedPathNodes.has(node)
            ? data.size * 1.12
            : data.kind === 'File' && !importsVisible
              ? data.size * 0.52
              : data.size,
      zIndex:
        node === selectedNodeId || selectedPathNodes.has(node)
          ? 1
          : data.zIndex,
    }));
    renderer.setSetting('edgeReducer', (edge, data) => {
      const match = edgeById.get(edge);
      const activeHierarchy = selectedPathEdges.has(edge);
      const activeImport =
        match?.relationship === 'IMPORTS' &&
        selectedNodeId !== null &&
        (match.source === selectedNodeId || match.target === selectedNodeId);
      const hiddenAtOverview =
        match?.relationship === 'IMPORTS' &&
        !importsVisible &&
        !activeImport;
      return {
        ...data,
        hidden:
          match === undefined ||
          !matchingNodeIds.has(match.source) ||
          !matchingNodeIds.has(match.target) ||
          hiddenAtOverview,
        color: activeHierarchy
          ? '#4f7f5d'
          : activeImport
            ? '#476551'
            : data.color,
        size:
          activeHierarchy || activeImport
            ? Math.max(data.size, 0.8)
            : data.size,
        zIndex: activeHierarchy || activeImport ? 1 : data.zIndex,
      };
    });
    const updateImportDetail = () => {
      const next =
        normalizedSearch.length > 0 || camera.ratio < 0.62;
      if (next === importsVisible) return;
      importsVisible = next;
      renderer.refresh();
    };
    camera.on('updated', updateImportDetail);
    renderer.refresh();

    if (
      normalizedSearch !== previousSearchRef.current &&
      normalizedSearch.length > 0 &&
      matchingNodes.length > 0
    ) {
      const firstMatch = renderer.getNodeDisplayData(matchingNodes[0].id);
      if (firstMatch !== undefined) {
        renderer.getCamera().animate(
          {
            x: firstMatch.x,
            y: firstMatch.y,
            ratio: matchingNodes.length <= 5 ? 0.12 : 0.35,
          },
          { duration: 220 },
        );
      }
    } else if (
      normalizedSearch.length === 0 &&
      previousSearchRef.current.length > 0
    ) {
      void renderer.getCamera().animatedReset({ duration: 220 });
    }
    previousSearchRef.current = normalizedSearch;
    return () => {
      camera.off('updated', updateImportDetail);
    };
  }, [payload, search, selectedNodeId]);

  useEffect(() => {
    const camera = rendererRef.current?.getCamera();
    if (camera === undefined || command === null) return;
    if (command.type === 'zoom-in') void camera.animatedZoom({ duration: 180 });
    if (command.type === 'zoom-out') void camera.animatedUnzoom({ duration: 180 });
    if (command.type === 'fit') void camera.animatedReset({ duration: 220 });
  }, [command]);

  return (
    <div className="sigma-canvas-wrap">
      <div
        ref={containerRef}
        className="sigma-canvas"
        role="img"
        aria-label={`WebGL repository graph with ${payload.visibleNodeCount.toLocaleString()} authorized nodes`}
      />
      {viewportBoundaries.length > 0 && (
        <svg
          className="feature-boundary-layer sigma-feature-boundaries"
          aria-label="Feature cluster boundaries"
        >
          {viewportBoundaries.map((boundary) => (
            <g
              key={boundary.id}
              role="button"
              tabIndex={0}
              aria-label={`Open ${boundary.label} feature details`}
              onClick={() => onSelectBoundary?.(boundary.id)}
              onKeyDown={(event) =>
                activateBoundary(event, boundary.id, onSelectBoundary)
              }
            >
              <rect
                className="feature-boundary-visible"
                x={boundary.x}
                y={boundary.y}
                width={boundary.width}
                height={boundary.height}
                rx={18}
              />
              <rect
                className="feature-boundary-hit"
                x={boundary.x}
                y={boundary.y}
                width={boundary.width}
                height={boundary.height}
                rx={18}
              />
              <text
                className="feature-boundary-label"
                x={boundary.x + 14}
                y={boundary.y + 21}
              >
                {boundary.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

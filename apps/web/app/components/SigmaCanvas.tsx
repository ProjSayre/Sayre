'use client';

import { useEffect, useRef, useState } from 'react';
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
      defaultEdgeColor: '#41423b',
      defaultNodeColor: '#7fb18e',
      labelColor: { color: '#e8e6e1' },
      labelDensity: 0.08,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 2.5,
      renderEdgeLabels: false,
      zIndex: true,
      nodeReducer: (node, data) => ({
        ...data,
        label: data.kind === 'Folder' ? data.label : '',
      }),
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

    renderer.setSetting('nodeReducer', (node, data) => ({
      ...data,
      hidden: !matchingNodeIds.has(node),
      label:
        data.kind === 'Folder' ||
        node === selectedNodeId ||
        normalizedSearch.length > 0
          ? data.label
          : '',
      color: node === selectedNodeId ? '#d8c87f' : data.color,
      size: node === selectedNodeId ? data.size * 1.45 : data.size,
      zIndex: node === selectedNodeId ? 1 : data.zIndex,
    }));
    renderer.setSetting('edgeReducer', (edge, data) => {
      const match = edgeById.get(edge);
      return {
        ...data,
        hidden:
          match === undefined ||
          !matchingNodeIds.has(match.source) ||
          !matchingNodeIds.has(match.target),
      };
    });
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

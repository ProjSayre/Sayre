'use client';

import { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import type { AuthorizedCanvasNode, AuthorizedCanvasPayload } from '../lib/scaleGraph';
import { toPresentationGraph } from '../lib/scaleGraph';

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
}

interface ViewportBoundary extends SigmaBoundary {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  boundaries = [],
  onSelectBoundary,
}: SigmaCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportBoundaries, setViewportBoundaries] = useState<ViewportBoundary[]>([]);

  useEffect(() => {
    if (containerRef.current === null) return undefined;

    const graph = toPresentationGraph(payload);
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: false,
      defaultEdgeColor: '#303b47',
      defaultNodeColor: '#77a7ff',
      labelColor: { color: '#dce5ef' },
      labelDensity: 0.08,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 8,
      renderEdgeLabels: false,
      zIndex: true,
    });

    renderer.on('clickNode', ({ node }) => {
      const match = payload.nodes.find((candidate) => candidate.id === node);
      if (match !== undefined) onSelect(match);
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
    };
  }, [boundaries, onSelect, payload]);

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

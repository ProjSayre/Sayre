'use client';

import { useEffect, useRef } from 'react';
import Sigma from 'sigma';
import type { AuthorizedCanvasNode, AuthorizedCanvasPayload } from '../lib/scaleGraph';
import { toPresentationGraph } from '../lib/scaleGraph';

interface SigmaCanvasProps {
  payload: AuthorizedCanvasPayload;
  onSelect: (node: AuthorizedCanvasNode) => void;
}

export function SigmaCanvas({ payload, onSelect }: SigmaCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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

    return () => renderer.kill();
  }, [onSelect, payload]);

  return (
    <div
      ref={containerRef}
      className="sigma-canvas"
      role="img"
      aria-label={`WebGL repository graph with ${payload.visibleNodeCount.toLocaleString()} authorized nodes`}
    />
  );
}

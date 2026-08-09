'use client';

import { useCallback, useMemo, type ReactNode } from 'react';
import { ProductTreeCanvas } from '../canvas/ProductTreeCanvas';
import { rendererFor } from '../rendererRegistry';
import { useWorkspaceQueries, useWorkspaceSelection } from '../state';
import { isStructuralEdge } from '../types';
import { useMeasuredWorkspaceCanvas, WorkspaceViewRuntimeProvider, type WorkspaceViewCanvasProps } from './WorkspaceViewRuntime';

export const productWorkspaceContribution = Object.freeze({
  id: 'product',
  capability: 'sayre.product',
  surface: 'sayre.primary-surface@1',
});

export function ProductWorkspaceView({ children }: { children: ReactNode }) {
  const { graph } = useWorkspaceQueries();
  const selection = useWorkspaceSelection();
  const { canvasRef } = useMeasuredWorkspaceCanvas();
  const structuralEdges = useMemo(() => graph.edges.filter(isStructuralEdge), [graph.edges]);
  const selectFeature = useCallback((featureId: string) => selection.selectFeature(featureId), [selection]);
  const selectNode = useCallback((nodeId: string) => selection.selectNode(nodeId), [selection]);
  const clearSelection = useCallback(() => selection.clearSelection(), [selection]);
  const renderer = rendererFor('product', graph.nodes.length);
  const value = {
    id: 'product' as const,
    title: 'Product Tree',
    loadingLabel: 'Product Tree',
    visibleNodeCount: graph.nodes.length,
    visibleEdgeCount: graph.edges.length,
    renderer,
    countLabel: `${graph.features.length} features · ${graph.productCoverage?.mappedFileCount ?? graph.nodes.length} mapped files`,
    canvasRef,
    renderCanvas: ({ command, showMinimap, fitKey }: WorkspaceViewCanvasProps) => (
      <ProductTreeCanvas
        graphNodes={graph.nodes}
        graphEdges={structuralEdges}
        features={graph.features}
        command={command}
        selectedFeatureId={selection.selectedFeatureId}
        selectedNodeId={selection.selectedNodeId}
        showMinimap={showMinimap}
        fitKey={fitKey}
        onSelectFeature={selectFeature}
        onSelectNode={selectNode}
        onClearSelection={clearSelection}
      />
    ),
    statusLine: `feature map · ${graph.features.length} features${graph.productCoverage === null ? '' : ` · ${graph.productCoverage.mappedFileCount}/${graph.productCoverage.totalFileCount} files mapped`}`,
  };
  return <WorkspaceViewRuntimeProvider value={value}><section data-workspace-view="product">{children}</section></WorkspaceViewRuntimeProvider>;
}

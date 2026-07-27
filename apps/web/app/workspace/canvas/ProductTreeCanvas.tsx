'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MiniMap,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import type { Feature, GraphEdge, GraphNode } from '../types';
import type { CanvasCommand } from '../rendererRegistry';
import {
  ProductFeatureNode,
  type ProductFeatureNodeData,
} from './ProductFeatureNode';
import {
  FEATURE_LABEL_WIDTH,
  buildProductFeatureClusters,
  buildProductFeatureConnections,
  layoutProductFeatureClusters,
  productFeatureFocus,
  type ProductFeatureConnection,
  type ProductFeatureCluster,
} from './productGraph';

interface ProductTreeCanvasProps {
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  features: Feature[];
  command: CanvasCommand | null;
  selectedFeatureId: string | null;
  selectedNodeId: string | null;
  showMinimap: boolean;
  /** Changes whenever the canvas column resizes, so the graph refits. */
  fitKey: string;
  onSelectFeature: (featureId: string) => void;
  onSelectNode: (nodeId: string) => void;
}

interface OpenDirectory {
  featureId: string;
  directoryId: string;
}

const PRODUCT_NODE_TYPES = {
  productFeature: ProductFeatureNode,
};

function connectionLabel(
  connection: ProductFeatureConnection,
  clusterById: ReadonlyMap<string, ProductFeatureCluster>,
): string {
  const parts: string[] = [];
  if (connection.sharedFileIds.length > 0) {
    parts.push(
      `${connection.sharedFileIds.length} shared ${
        connection.sharedFileIds.length === 1 ? 'file' : 'files'
      }`,
    );
  }
  const sourceName =
    clusterById.get(connection.sourceFeatureId)?.name ?? 'Feature';
  const targetName =
    clusterById.get(connection.targetFeatureId)?.name ?? 'feature';
  if (connection.sourceToTargetDependencyCount > 0) {
    parts.push(
      `${sourceName} imports ${targetName} (${connection.sourceToTargetDependencyCount})`,
    );
  }
  if (connection.targetToSourceDependencyCount > 0) {
    parts.push(
      `${targetName} imports ${sourceName} (${connection.targetToSourceDependencyCount})`,
    );
  }
  return parts.join(' · ');
}

/**
 * Product Tree renders features as the primary graph grammar. Each dashed frame
 * owns directory and file glyphs, while feature-to-feature links summarize
 * shared membership and authorized import relationships.
 */
export function ProductTreeCanvas({
  graphNodes,
  graphEdges,
  features,
  command,
  selectedFeatureId,
  selectedNodeId,
  showMinimap,
  fitKey,
  onSelectFeature,
  onSelectNode,
}: ProductTreeCanvasProps) {
  const flow = useReactFlow();
  const [maximumColumns, setMaximumColumns] = useState(4);
  const [hoveredFeatureId, setHoveredFeatureId] = useState<string | null>(null);
  const [openDirectory, setOpenDirectory] = useState<OpenDirectory | null>(null);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [inventoryQuery, setInventoryQuery] = useState('');

  useEffect(() => {
    const update = (): void => {
      if (window.innerWidth <= 620) setMaximumColumns(1);
      else if (window.innerWidth <= 1_000) setMaximumColumns(2);
      else setMaximumColumns(4);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (openDirectory === null) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenDirectory(null);
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [openDirectory]);

  const clusters = useMemo(
    () => buildProductFeatureClusters(graphNodes, features),
    [features, graphNodes],
  );
  const connections = useMemo(
    () => buildProductFeatureConnections(features, graphEdges),
    [features, graphEdges],
  );
  const placements = useMemo(
    () =>
      layoutProductFeatureClusters(clusters, connections, maximumColumns),
    [clusters, connections, maximumColumns],
  );
  const clusterById = useMemo(
    () => new Map(clusters.map((cluster) => [cluster.id, cluster])),
    [clusters],
  );
  const focus = useMemo(
    () => productFeatureFocus(selectedFeatureId, connections),
    [connections, selectedFeatureId],
  );
  const normalizedInventoryQuery = inventoryQuery.trim().toLowerCase();
  const inventoryClusters = useMemo(
    () =>
      [...clusters]
        .filter(
          (cluster) =>
            normalizedInventoryQuery.length === 0 ||
            [cluster.name, cluster.description ?? '', cluster.team ?? ''].some(
              (value) =>
                value.toLowerCase().includes(normalizedInventoryQuery),
            ),
        )
        .sort(
          (left, right) =>
            (left.team ?? '').localeCompare(right.team ?? '') ||
            left.name.localeCompare(right.name),
        ),
    [clusters, normalizedInventoryQuery],
  );

  const nodes = useMemo<Node<ProductFeatureNodeData>[]>(() => {
    return placements.map(({ cluster, x, y }) => {
      const selected = cluster.id === selectedFeatureId;
      const containsSelectedFile =
        selectedNodeId !== null && cluster.memberIds.includes(selectedNodeId);
      const directoryOpen =
        openDirectory?.featureId === cluster.id
          ? openDirectory.directoryId
          : null;

      return {
        id: `feature:${cluster.id}`,
        type: 'productFeature',
        position: { x, y },
        style: {
          width: cluster.diameter + FEATURE_LABEL_WIDTH,
          height: cluster.diameter,
        },
        draggable: false,
        connectable: false,
        selectable: false,
        zIndex:
          selected || containsSelectedFile || directoryOpen !== null ? 4 : 1,
        data: {
          cluster,
          selected,
          containsSelectedFile,
          dimmed:
            focus !== null && !focus.adjacentFeatureIds.has(cluster.id),
          matched: false,
          selectedNodeId,
          matchedFileIds: [],
          openDirectoryId: directoryOpen,
          onSelectFeature: () => onSelectFeature(cluster.id),
          onSelectFile: onSelectNode,
          onToggleDirectory: (directoryId) =>
            setOpenDirectory((current) =>
              current?.featureId === cluster.id &&
              current.directoryId === directoryId
                ? null
                : { featureId: cluster.id, directoryId },
            ),
          onCloseDirectory: () => setOpenDirectory(null),
        },
      };
    });
  }, [
    onSelectFeature,
    onSelectNode,
    openDirectory,
    placements,
    focus,
    selectedFeatureId,
    selectedNodeId,
  ]);

  const edges = useMemo<Edge[]>(() => {
    return connections.map((connection) => {
      const selectionActive =
        focus?.activeConnectionIds.has(connection.id) === true;
      const hoverActive =
        selectedFeatureId === null &&
        (connection.sourceFeatureId === hoveredFeatureId ||
          connection.targetFeatureId === hoveredFeatureId);
      const fileActive =
        selectedFeatureId === null &&
        selectedNodeId !== null &&
        (clusterById
          .get(connection.sourceFeatureId)
          ?.memberIds.includes(selectedNodeId) === true ||
          clusterById
            .get(connection.targetFeatureId)
            ?.memberIds.includes(selectedNodeId) === true);
      const active =
        selectionActive ||
        hoverActive ||
        fileActive;
      const dimmed =
        focus !== null && !focus.activeConnectionIds.has(connection.id);
      const relation = connectionLabel(connection, clusterById);
      return {
        id: connection.id,
        source: `feature:${connection.sourceFeatureId}`,
        target: `feature:${connection.targetFeatureId}`,
        type: 'straight',
        className: [
          'mock-feature-connection',
          connection.sharedFileIds.length > 0
            ? 'mock-feature-connection-shared'
            : 'mock-feature-connection-dependency',
          active ? 'mock-edge-active' : '',
          dimmed ? 'mock-edge-dimmed' : '',
        ]
          .filter(Boolean)
          .join(' '),
        // Relationship prose belongs in the selected feature drawer. Showing
        // every incident label on hover causes unreadable collisions at scale.
        label: undefined,
        ...(connection.sourceToTargetDependencyCount > 0
          ? {
              markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 14,
                height: 14,
                color: '#687066',
              },
            }
          : {}),
        ...(connection.targetToSourceDependencyCount > 0
          ? {
              markerStart: {
                type: MarkerType.ArrowClosed,
                width: 14,
                height: 14,
                color: '#687066',
              },
            }
          : {}),
        ariaLabel: `${clusterById.get(connection.sourceFeatureId)?.name ?? 'Feature'} to ${
          clusterById.get(connection.targetFeatureId)?.name ?? 'feature'
        }: ${relation}`,
        zIndex: active ? 1 : 0,
      };
    });
  }, [
    clusterById,
    connections,
    focus,
    hoveredFeatureId,
    selectedFeatureId,
    selectedNodeId,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (maximumColumns < 4 && features.length > maximumColumns * 2) {
        void flow.setViewport(
          {
            x: maximumColumns === 1 ? 28 : 36,
            y: maximumColumns === 1 ? 32 : 44,
            zoom: maximumColumns === 1 ? 0.74 : 0.7,
          },
          { duration: 0 },
        );
        return;
      }
      void flow.fitView({
        padding: 0.12,
        minZoom: 0.32,
        maxZoom: 1.08,
      });
    }, 80);
    return () => clearTimeout(timer);
  }, [features.length, fitKey, flow, maximumColumns, placements]);

  useEffect(() => {
    if (command === null) return;
    if (command.type === 'zoom-in') void flow.zoomIn();
    if (command.type === 'zoom-out') void flow.zoomOut();
    if (command.type === 'fit') {
      void flow.fitView({
        padding: 0.12,
        minZoom: 0.18,
        maxZoom: 1.08,
        duration: 220,
      });
    }
  }, [command, flow]);

  return (
    <ReactFlow
      className="mock-flow mock-product-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={PRODUCT_NODE_TYPES}
      onNodeMouseEnter={(_event, node) =>
        setHoveredFeatureId(node.id.slice('feature:'.length))
      }
      onNodeMouseLeave={() => setHoveredFeatureId(null)}
      onPaneClick={() => setOpenDirectory(null)}
      fitView
      fitViewOptions={{
        padding: 0.12,
        minZoom: 0.32,
        maxZoom: 1.08,
      }}
      minZoom={0.18}
      maxZoom={2.4}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Panel position="top-left" className="mock-product-legend">
        <span>
          <i className="is-feature" /> feature
        </span>
        <span>
          <i className="is-directory" /> directory
        </span>
        <span>
          <i className="is-file" /> file
        </span>
        <span>
          <i className="is-import" /> imports →
        </span>
        <span className="mock-product-link-count">
          {connections.length}{' '}
          {connections.length === 1 ? 'feature link' : 'feature links'}
        </span>
      </Panel>
      <Panel position="top-right" className="mock-feature-index">
        <button
          type="button"
          className="mock-feature-index-trigger"
          aria-expanded={inventoryOpen}
          onClick={() => setInventoryOpen((open) => !open)}
        >
          <span>Feature inventory</span>
          <strong>{clusters.length}</strong>
          <span aria-hidden="true">{inventoryOpen ? '▴' : '▾'}</span>
        </button>
        {inventoryOpen && (
          <>
            <div className="mock-feature-index-search">
              <input
                type="search"
                aria-label="Filter features"
                value={inventoryQuery}
                placeholder="Filter features…"
                onChange={(event) => setInventoryQuery(event.target.value)}
              />
              {inventoryQuery.length > 0 && (
                <button
                  type="button"
                  aria-label="Clear feature filter"
                  onClick={() => setInventoryQuery('')}
                >
                  ×
                </button>
              )}
            </div>
            <div className="mock-feature-index-list">
              {inventoryClusters.map((cluster) => (
                <button
                  key={cluster.id}
                  type="button"
                  className="mock-feature-index-row"
                  aria-current={
                    cluster.id === selectedFeatureId ? 'true' : undefined
                  }
                  onClick={() => onSelectFeature(cluster.id)}
                >
                  <span>
                    <strong>{cluster.name}</strong>
                    <small>{cluster.team ?? 'Unassigned team'}</small>
                  </span>
                  <em>
                    {cluster.fileCount}{' '}
                    {cluster.fileCount === 1 ? 'file' : 'files'}
                  </em>
                </button>
              ))}
              {inventoryClusters.length === 0 && (
                <p className="mock-feature-index-empty">No matching features.</p>
              )}
            </div>
          </>
        )}
      </Panel>
      {showMinimap && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          maskColor="rgba(19, 20, 18, 0.72)"
          nodeStrokeWidth={12}
          nodeStrokeColor="#55554e"
          nodeColor="#30322e"
        />
      )}
    </ReactFlow>
  );
}

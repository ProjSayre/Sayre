'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MiniMap,
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
  type ProductFeatureConnection,
} from './productGraph';

interface ProductTreeCanvasProps {
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  features: Feature[];
  command: CanvasCommand | null;
  selectedFeatureId: string | null;
  selectedNodeId: string | null;
  search: string;
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

function connectionLabel(connection: ProductFeatureConnection): string {
  const parts: string[] = [];
  if (connection.sharedFileIds.length > 0) {
    parts.push(
      `${connection.sharedFileIds.length} shared ${
        connection.sharedFileIds.length === 1 ? 'file' : 'files'
      }`,
    );
  }
  if (connection.dependencyCount > 0) {
    parts.push(
      `${connection.dependencyCount} code ${
        connection.dependencyCount === 1 ? 'dependency' : 'dependencies'
      }`,
    );
  }
  return parts.join(' · ');
}

/**
 * Product Tree renders features as the primary graph grammar. Each dashed ring
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
  search,
  showMinimap,
  fitKey,
  onSelectFeature,
  onSelectNode,
}: ProductTreeCanvasProps) {
  const flow = useReactFlow();
  const [maximumColumns, setMaximumColumns] = useState(4);
  const [hoveredFeatureId, setHoveredFeatureId] = useState<string | null>(null);
  const [openDirectory, setOpenDirectory] = useState<OpenDirectory | null>(null);

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
  const query = search.trim().toLowerCase();

  const nodes = useMemo<Node<ProductFeatureNodeData>[]>(() => {
    return placements.map(({ cluster, x, y }) => {
      const featureMatched =
        query.length > 0 &&
        [cluster.name, cluster.description ?? '', cluster.team ?? ''].some(
          (value) => value.toLowerCase().includes(query),
        );
      const matchedFileIds =
        query.length === 0
          ? []
          : cluster.directories.flatMap(({ files }) =>
              files
                .filter(
                  (file) =>
                    file.name.toLowerCase().includes(query) ||
                    file.path.toLowerCase().includes(query),
                )
                .map(({ id }) => id),
            );
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
            query.length > 0 &&
            !featureMatched &&
            matchedFileIds.length === 0,
          matched: featureMatched,
          selectedNodeId,
          matchedFileIds,
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
    query,
    selectedFeatureId,
    selectedNodeId,
  ]);

  const edges = useMemo<Edge[]>(() => {
    return connections.map((connection) => {
      const active =
        connection.sourceFeatureId === selectedFeatureId ||
        connection.targetFeatureId === selectedFeatureId ||
        connection.sourceFeatureId === hoveredFeatureId ||
        connection.targetFeatureId === hoveredFeatureId ||
        (selectedNodeId !== null &&
          (clusterById
            .get(connection.sourceFeatureId)
            ?.memberIds.includes(selectedNodeId) === true ||
            clusterById
              .get(connection.targetFeatureId)
              ?.memberIds.includes(selectedNodeId) === true));
      const relation = connectionLabel(connection);
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
        ]
          .filter(Boolean)
          .join(' '),
        label: active ? relation : undefined,
        labelStyle: {
          fill: '#d8d7cf',
          fontFamily: 'var(--mono)',
          fontSize: 10,
        },
        labelBgStyle: {
          fill: '#181916',
          fillOpacity: 0.94,
        },
        labelBgPadding: [5, 4],
        labelBgBorderRadius: 3,
        ariaLabel: `${clusterById.get(connection.sourceFeatureId)?.name ?? 'Feature'} to ${
          clusterById.get(connection.targetFeatureId)?.name ?? 'feature'
        }: ${relation}`,
        zIndex: 0,
      };
    });
  }, [
    clusterById,
    connections,
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
        <span className="mock-product-link-count">
          {connections.length}{' '}
          {connections.length === 1 ? 'feature link' : 'feature links'}
        </span>
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

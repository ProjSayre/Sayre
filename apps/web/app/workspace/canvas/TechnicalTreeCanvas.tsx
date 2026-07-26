'use client';

import { useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import type { AuthorizedCanvasPayload } from '../../lib/scaleGraph';
import type { GraphEdge, GraphNode } from '../types';
import type { CanvasCommand, RendererId } from '../rendererRegistry';
import { NODE_TYPES } from './nodes';
import { NODE_BOX, layoutTree, toBoxOrigin } from './layout';

interface TechnicalTreeCanvasProps {
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  renderer: RendererId;
  command: CanvasCommand | null;
  selectedId: string | null;
  search: string;
  showMinimap: boolean;
  /** Changes whenever the canvas column resizes, so the graph refits. */
  fitKey: string;
  onSelect: (nodeId: string) => void;
}

/** Root → node path, so the whole ancestry lights up rather than one edge. */
const SigmaCanvas = dynamic(
  () => import('../../components/SigmaCanvas').then((module) => module.SigmaCanvas),
  { ssr: false },
);

function ancestryOf(
  graphNodes: GraphNode[],
  nodeId: string | null,
): Set<string> {
  const path = new Set<string>();
  if (nodeId === null) return path;
  const byId = new Map(graphNodes.map((node) => [node.id, node]));
  let current: GraphNode | undefined = byId.get(nodeId);
  while (current !== undefined) {
    path.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}

export function TechnicalTreeCanvas({
  graphNodes,
  graphEdges,
  renderer,
  command,
  selectedId,
  search,
  showMinimap,
  fitKey,
  onSelect,
}: TechnicalTreeCanvasProps) {
  const flow = useReactFlow();

  // Opening the drawer narrows the canvas; without this the graph stays where
  // it was and slides under the drawer.
  useEffect(() => {
    const timer = setTimeout(
      () => flow.fitView({ padding: 0.1, maxZoom: 1 }),
      80,
    );
    return () => clearTimeout(timer);
  }, [fitKey, flow]);

  useEffect(() => {
    if (renderer !== 'react-flow' || command === null) return;
    if (command.type === 'zoom-in') void flow.zoomIn();
    if (command.type === 'zoom-out') void flow.zoomOut();
    if (command.type === 'fit') {
      void flow.fitView({ padding: 0.1, maxZoom: 1 });
    }
  }, [command, flow, renderer]);

  const { nodes, edges } = useMemo(() => {
    const positions = layoutTree(graphNodes);
    const ancestry = ancestryOf(graphNodes, selectedId);
    const query = search.trim().toLowerCase();

    const matches = (node: GraphNode): boolean =>
      query.length > 0 &&
      (node.name.toLowerCase().includes(query) ||
        node.path.toLowerCase().includes(query));

    const flowNodes: Node[] = graphNodes.map((node) => {
      const point = positions.get(node.id) ?? { x: 0, y: 0 };
      const matched = matches(node);
      return {
        id: node.id,
        type: 'graphNode',
        position: toBoxOrigin(point),
        // Declared so the minimap has dimensions before measurement lands.
        width: NODE_BOX,
        height: NODE_BOX,
        draggable: false,
        connectable: false,
        data: {
          name: node.name,
          kind: node.kind,
          isRoot: node.parentId === null,
          selected: node.id === selectedId,
          dimmed: query.length > 0 && !matched,
          matched,
        },
      };
    });

    const flowEdges: Edge[] = graphEdges.map((edge) => {
      const isContains = edge.type === 'CONTAINS';
      const active =
        isContains && ancestry.has(edge.source) && ancestry.has(edge.target);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // Containment is the tree: straight, centre-to-centre. Imports cut
        // across the tree, so they curve to stay legible where they overlap.
        type: isContains ? 'straight' : 'default',
        className: [
          isContains ? 'mock-edge-contains' : 'mock-edge-imports',
          active ? 'mock-edge-active' : '',
        ]
          .filter(Boolean)
          .join(' '),
        selectable: false,
        focusable: false,
      };
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [graphEdges, graphNodes, search, selectedId]);

  const sigmaPayload = useMemo<AuthorizedCanvasPayload>(() => {
    const positions = layoutTree(graphNodes);
    return {
      authorization: 'server-filtered',
      visibleNodeCount: graphNodes.length,
      nodes: graphNodes.map((node) => {
        const point = positions.get(node.id) ?? { x: 0, y: 0 };
        return {
          id: node.id,
          kind: node.kind,
          label: node.name,
          path: node.path,
          x: point.x,
          y: point.y,
        };
      }),
      edges: graphEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relationship: edge.type,
      })),
    };
  }, [graphEdges, graphNodes]);

  if (renderer === 'sigma') {
    return (
      <SigmaCanvas
        payload={sigmaPayload}
        command={command}
        search={search}
        selectedNodeId={selectedId}
        onSelect={(node) => onSelect(node.id)}
      />
    );
  }

  return (
    <ReactFlow
      className="mock-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_event, node) => onSelect(node.id)}
      fitView
      fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={2.4}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      {showMinimap && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          maskColor="rgba(19, 20, 18, 0.72)"
          nodeStrokeWidth={14}
          nodeStrokeColor={(node) =>
            (node.data as { kind?: string }).kind === 'Folder' ? '#8b8b82' : '#55554e'
          }
          nodeColor={(node) =>
            (node.data as { kind?: string }).kind === 'Folder' ? '#8b8b82' : '#55554e'
          }
        />
      )}
    </ReactFlow>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  MiniMap,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import {
  coverageColor,
  type AuthorizedCanvasPayload,
} from '../../lib/scaleGraph';
import type { GraphEdge, GraphNode } from '../types';
import type { CanvasCommand, RendererId } from '../rendererRegistry';
import type { TechnicalExpansionProjection } from '../technicalExpansion';
import { NODE_TYPES, type GraphNodeData } from './nodes';
import {
  NODE_BOX,
  type FolderLabelMetadata,
  layoutScalableTree,
  layoutTree,
  toBoxOrigin,
} from './layout';

interface TechnicalTreeCanvasProps {
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  rootLabel: string;
  renderer: RendererId;
  command: CanvasCommand | null;
  selectedId: string | null;
  cameraFocusId?: string | null;
  preserveCameraZoom?: boolean;
  search: string;
  showMinimap: boolean;
  /** Changes whenever the canvas column resizes, so the graph refits. */
  fitKey: string;
  /** Changes only when the deterministic visible projection changes. */
  layoutKey?: string;
  expansion?: TechnicalExpansionProjection;
  onSelect: (nodeId: string) => void;
  onSetFolderExpanded?: (nodeId: string, expanded: boolean) => void;
  onTogglePinned?: (nodeId: string) => void;
  onRequestFullGraph?: (nodeId: string) => void;
}

/** Root → node path, so the whole ancestry lights up rather than one edge. */
const SigmaCanvas = dynamic(
  () =>
    import('../../components/SigmaCanvas').then(
      (module) => module.SigmaCanvas,
    ),
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
  rootLabel,
  renderer,
  command,
  selectedId,
  cameraFocusId = selectedId,
  preserveCameraZoom = false,
  search,
  showMinimap,
  fitKey,
  layoutKey = fitKey,
  expansion,
  onSelect,
  onSetFolderExpanded,
  onTogglePinned,
  onRequestFullGraph,
}: TechnicalTreeCanvasProps) {
  const flow = useReactFlow();
  const [portraitViewport, setPortraitViewport] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const fitPadding = portraitViewport ? 0.42 : 0.1;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setPortraitViewport(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // Opening the drawer narrows the canvas; without this the graph stays where
  // it was and slides under the drawer.
  useEffect(() => {
    const timer = setTimeout(
      () => flow.fitView({ padding: fitPadding, maxZoom: 1 }),
      80,
    );
    return () => clearTimeout(timer);
  }, [fitKey, fitPadding, flow]);

  useEffect(() => {
    if (renderer !== 'react-flow' || command === null) return;
    if (command.type === 'zoom-in') void flow.zoomIn();
    if (command.type === 'zoom-out') void flow.zoomOut();
    if (command.type === 'fit') {
      void flow.fitView({ padding: fitPadding, maxZoom: 1 });
    }
  }, [command, fitPadding, flow, renderer]);

  useEffect(() => {
    if (renderer !== 'react-flow') return undefined;
    const timer = window.setTimeout(() => {
      if (cameraFocusId === null) {
        void flow.fitView({
          padding: fitPadding,
          maxZoom: 1,
          duration: reducedMotion ? 0 : 220,
        });
        return;
      }
      const selected = flow.getNode(cameraFocusId);
      if (selected === undefined) return;
      const position = selected.position;
      void flow.setCenter(
        position.x + NODE_BOX / 2,
        position.y + NODE_BOX / 2,
        {
          duration: reducedMotion ? 0 : 220,
          zoom: preserveCameraZoom
            ? flow.getZoom()
            : Math.min(1.4, Math.max(0.9, flow.getZoom())),
        },
      );
    }, 125);
    return () => window.clearTimeout(timer);
  }, [
    fitKey,
    cameraFocusId,
    fitPadding,
    flow,
    layoutKey,
    preserveCameraZoom,
    reducedMotion,
    renderer,
  ]);

  const { nodes, edges } = useMemo(() => {
    const folderMetadataById = new Map<string, FolderLabelMetadata>();
    if (expansion !== undefined) {
      for (const node of graphNodes) {
        if (node.kind !== 'Folder') continue;
        const folderState = expansion.folderStateById.get(node.id);
        folderMetadataById.set(node.id, {
          foldedDescendantCount:
            folderState === 'collapsed'
              ? (expansion.foldedDescendantCount.get(node.id) ?? 0)
              : 0,
          hiddenImportCount:
            expansion.hiddenImportCount.get(node.id) ?? 0,
          visibleChildCount:
            expansion.visibleChildCount.get(node.id) ?? 0,
          totalChildCount:
            expansion.totalChildCount.get(node.id) ?? 0,
          contextual: folderState === 'contextual',
          hasPin:
            onTogglePinned !== undefined &&
            (expansion.totalChildCount.get(node.id) ?? 0) > 0,
        });
      }
    }
    const basePositions = layoutTree(graphNodes, { folderMetadataById });
    const positions = portraitViewport
      ? new Map(
          [...basePositions].map(([id, point]) => [
            id,
            { x: point.x * 0.86, y: point.y },
          ]),
        )
      : basePositions;
    const ancestry = ancestryOf(graphNodes, selectedId);
    const dependencyNeighbors = new Set<string>();
    if (selectedId !== null) {
      for (const edge of graphEdges) {
        if (edge.type !== 'IMPORTS') continue;
        if (edge.source === selectedId) {
          dependencyNeighbors.add(edge.target);
        } else if (edge.target === selectedId) {
          dependencyNeighbors.add(edge.source);
        }
      }
    }
    const query = search.trim().toLowerCase();

    const matches = (node: GraphNode): boolean =>
      query.length > 0 &&
      (node.name.toLowerCase().includes(query) ||
        node.path.toLowerCase().includes(query));

    const flowNodes: Node[] = graphNodes.map((node) => {
      const point = positions.get(node.id) ?? { x: 0, y: 0 };
      const matched = matches(node);
      const displayName = node.parentId === null ? rootLabel : node.name;
      const folderState = expansion?.folderStateById.get(node.id);
      const folderExpanded =
        folderState === 'expanded' || folderState === 'contextual';
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
          name: displayName,
          kind: node.kind,
          isRoot: node.parentId === null,
          selected: node.id === selectedId,
          dimmed: query.length > 0 && !matched,
          matched,
          related: dependencyNeighbors.has(node.id),
          ...(node.kind === 'Folder' && expansion !== undefined
            ? {
                folderState,
                visibleChildCount:
                  expansion.visibleChildCount.get(node.id) ?? 0,
                totalChildCount:
                  expansion.totalChildCount.get(node.id) ?? 0,
                foldedDescendantCount:
                  expansion.foldedDescendantCount.get(node.id) ?? 0,
                hiddenImportCount:
                  expansion.hiddenImportCount.get(node.id) ?? 0,
                pinned: expansion.pinnedBranchIds.has(node.id),
                onToggleFolder: (recursive: boolean) => {
                  if (recursive && expansion.mode !== 'full') {
                    onRequestFullGraph?.(node.id);
                    return;
                  }
                  onSetFolderExpanded?.(node.id, !folderExpanded);
                },
                ...(onTogglePinned === undefined ||
                (expansion.totalChildCount.get(node.id) ?? 0) === 0
                  ? {}
                  : { onTogglePinned: () => onTogglePinned(node.id) }),
              }
            : {}),
          ...(node.coverage === undefined
            ? {}
            : { coverage: node.coverage }),
        },
      };
    });

    const flowEdges: Edge[] = graphEdges.map((edge) => {
      const isContains = edge.type === 'CONTAINS';
      const active = isContains
        ? ancestry.has(edge.source) && ancestry.has(edge.target)
        : selectedId !== null &&
          (edge.source === selectedId || edge.target === selectedId);
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
        ...(isContains
          ? {}
          : {
              markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 12,
                height: 12,
                color: '#3a4038',
              },
            }),
      };
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [
    graphEdges,
    graphNodes,
    expansion,
    onRequestFullGraph,
    onSetFolderExpanded,
    onTogglePinned,
    portraitViewport,
    rootLabel,
    search,
    selectedId,
  ]);

  const sigmaPayload = useMemo<AuthorizedCanvasPayload>(() => {
    const positions = layoutScalableTree(
      graphNodes,
      portraitViewport ? 'portrait' : 'landscape',
    );
    return {
      authorization: 'server-filtered',
      visibleNodeCount: graphNodes.length,
      nodes: graphNodes.map((node) => {
        const point = positions.get(node.id) ?? { x: 0, y: 0 };
        return {
          id: node.id,
          kind: node.kind,
          label: node.parentId === null ? rootLabel : node.name,
          path: node.path,
          x: point.x,
          y: point.y,
          ...(node.coverage === undefined
            ? {}
            : { coverage: node.coverage }),
        };
      }),
      edges: graphEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relationship: edge.type,
      })),
    };
  }, [graphEdges, graphNodes, portraitViewport, rootLabel]);

  if (renderer === 'sigma') {
    return (
      <SigmaCanvas
        payload={sigmaPayload}
        command={command}
        fitKey={`${fitKey}:${layoutKey}`}
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
      onNodeClick={(_event, flowNode) => {
        const node = flowNode.data as GraphNodeData;
        // Matches Explorer activation, which expands and selects in one event.
        // Returning early here was why a folder could be opened from the graph
        // but never focused from it — only from the file tree.
        if (
          node.kind === 'Folder' &&
          node.folderState !== undefined &&
          node.folderState !== 'leaf'
        ) {
          node.onToggleFolder?.(false);
        }
        onSelect(flowNode.id);
      }}
      fitView
      fitViewOptions={{ padding: fitPadding, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={2.4}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      {expansion !== undefined && (
        <Panel position="top-left" className="mock-technical-legend">
          <span>
            <i className="is-containment" /> folder structure
          </span>
          <span>
            <i className="is-import" /> imports →
          </span>
        </Panel>
      )}
      {showMinimap && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          maskColor="rgba(19, 20, 18, 0.72)"
          nodeStrokeWidth={14}
          nodeStrokeColor={(node) =>
            (node.data as { kind?: string }).kind === 'Folder'
              ? '#8b8b82'
              : '#55554e'
          }
          nodeColor={(node) =>
            (node.data as { kind?: string }).kind === 'Folder'
              ? '#8b8b82'
              : coverageColor(
                  (
                    node.data as {
                      coverage?: { status?: Parameters<typeof coverageColor>[0] };
                    }
                  ).coverage?.status,
                )
          }
        />
      )}
    </ReactFlow>
  );
}

'use client';

import { useEffect, useMemo } from 'react';
import {
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import {
  resolveProgress,
  type PrerequisiteGraph,
} from '../../lib/prerequisiteGraph';
import type { CanvasCommand } from '../rendererRegistry';
import {
  PREREQUISITE_NODE_TYPES,
  type PrerequisiteNodeData,
} from './PrerequisiteNode';

const LAYER_X = 210;
const ROW_Y = 66;
const GROUP_GAP = 14;
const FIT_OPTIONS = { padding: 0.08, maxZoom: 1 } as const;

interface PrerequisiteCanvasProps {
  graph: PrerequisiteGraph;
  doneIds: ReadonlySet<string>;
  command: CanvasCommand | null;
  selectedId: string | null;
  search: string;
  fitKey: string;
  onSelect: (nodeId: string) => void;
}

/**
 * Lays the reading order out left to right: everything in a column can be read
 * once the columns to its left are done. Cycle members are placed adjacently
 * and share a band, because they have no safe order among themselves.
 */
export function PrerequisiteCanvas({
  graph,
  doneIds,
  command,
  selectedId,
  search,
  fitKey,
  onSelect,
}: PrerequisiteCanvasProps) {
  const flow = useReactFlow();
  const query = search.trim().toLowerCase();

  useEffect(() => {
    const timer = setTimeout(() => flow.fitView(FIT_OPTIONS), 80);
    return () => clearTimeout(timer);
  }, [fitKey, flow, graph]);

  // `fitKey` only changes when a panel opens, so without this the graph keeps
  // whatever zoom it was given at first paint — which is wrong at every window
  // size but the one it happened to mount at.
  useEffect(() => {
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => flow.fitView(FIT_OPTIONS));
    };
    window.addEventListener('resize', refit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', refit);
    };
  }, [flow]);

  useEffect(() => {
    if (command === null) return;
    if (command.type === 'zoom-in') void flow.zoomIn();
    if (command.type === 'zoom-out') void flow.zoomOut();
    if (command.type === 'fit') void flow.fitView(FIT_OPTIONS);
  }, [command, flow]);

  const progress = useMemo(
    () => resolveProgress(graph, doneIds),
    [graph, doneIds],
  );

  const nodes = useMemo<Node[]>(() => {
    const ordered = [...graph.nodes].sort(
      (a, b) =>
        a.layer - b.layer ||
        a.groupId.localeCompare(b.groupId) ||
        a.path.localeCompare(b.path),
    );
    const rowByLayer = new Map<number, number>();
    const lastGroupByLayer = new Map<number, string>();
    const offsetByLayer = new Map<number, number>();

    return ordered.map((node) => {
      const row = rowByLayer.get(node.layer) ?? 0;
      rowByLayer.set(node.layer, row + 1);

      // Nudge a fresh group down slightly so bundles read as separate clusters
      // rather than one undifferentiated column.
      const previousGroup = lastGroupByLayer.get(node.layer);
      let offset = offsetByLayer.get(node.layer) ?? 0;
      if (previousGroup !== undefined && previousGroup !== node.groupId) {
        offset += GROUP_GAP;
        offsetByLayer.set(node.layer, offset);
      }
      lastGroupByLayer.set(node.layer, node.groupId);

      const matched = query.length > 0 && node.path.toLowerCase().includes(query);
      return {
        id: node.id,
        type: 'prerequisite',
        position: { x: node.layer * LAYER_X, y: row * ROW_Y + offset },
        data: {
          name: node.name,
          path: node.path,
          layer: node.layer,
          progress: progress.get(node.id) ?? 'locked',
          selected: node.id === selectedId,
          matched,
          dimmed: query.length > 0 && !matched,
          groupSize: node.groupSize,
        } satisfies PrerequisiteNodeData,
      };
    });
  }, [graph, progress, query, selectedId]);

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        className: edge.withinGroup
          ? 'mock-prereq-edge is-entangled'
          : 'mock-prereq-edge',
        animated: false,
        markerEnd: edge.withinGroup
          ? undefined
          : { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      })),
    [graph],
  );

  const readable = [...progress.values()].filter(
    (state) => state === 'current',
  ).length;

  return (
    <ReactFlow
      className="mock-flow mock-prereq-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={PREREQUISITE_NODE_TYPES}
      onNodeClick={(_event, flowNode) => onSelect(flowNode.id)}
      fitView
      fitViewOptions={FIT_OPTIONS}
      minZoom={0.2}
      maxZoom={2.4}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      <Panel position="top-left" className="mock-prereq-legend">
        <span>
          <i className="is-current" /> ready now ({readable})
        </span>
        <span>
          <i className="is-locked" /> prerequisites outstanding
        </span>
        <span className="mock-prereq-axis">read order →</span>
      </Panel>
      {graph.cycleGroups.length > 0 && (
        <Panel position="bottom-left" className="mock-prereq-note">
          {graph.cycleGroups.length === 1
            ? '1 group of files imports each other, so there is no safe reading order inside it — learn each group as a unit.'
            : `${graph.cycleGroups.length} groups of files import each other, so there is no safe reading order inside them — learn each group as a unit.`}
        </Panel>
      )}
    </ReactFlow>
  );
}

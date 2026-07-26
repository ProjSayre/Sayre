'use client';

import { useEffect, useMemo, useState } from 'react';
import { MiniMap, ReactFlow, useReactFlow, type Node } from '@xyflow/react';
import type { Feature, GraphNode } from '../types';
import type { CanvasCommand } from '../rendererRegistry';
import { NODE_TYPES } from './nodes';
import { NODE_BOX } from './layout';

interface ProductTreeCanvasProps {
  graphNodes: GraphNode[];
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

const CELL_H = 38;
const PAD = 22;
const GAP_X = 92;
const GAP_Y = 104;
const CHAR_WIDTH = 6.4;
const LABEL_OFFSET = 22;
const MIN_WIDTH = 240;

/** A boundary has to be wide enough for its longest file path. */
function boundaryWidth(paths: string[]): number {
  const longest = paths.reduce((max, path) => Math.max(max, path.length), 0);
  return Math.max(MIN_WIDTH, longest * CHAR_WIDTH + LABEL_OFFSET + PAD * 2);
}

/**
 * Feature boundaries, not folders. A feature's files routinely live in
 * different directories — that crossing is the whole point of this view.
 */
export function ProductTreeCanvas({
  graphNodes,
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
  const [columns, setColumns] = useState(4);
  const fitMinimumZoom = columns === 1 ? 0.65 : 0.2;
  const presentationZoom =
    columns === 1 ? 0.65 : columns === 2 ? 0.78 : 0.72;

  useEffect(() => {
    const update = (): void => {
      if (window.innerWidth <= 620) setColumns(1);
      else if (window.innerWidth <= 1_000) setColumns(2);
      else setColumns(4);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (columns === 1 || features.length > columns) {
        // A real repository often has more features than one viewport can
        // legibly hold. Match the approved card scale, start at the first row,
        // and use the minimap for the full overview instead of shrinking every
        // filename into a miniature.
        void flow.setViewport(
          {
            x: columns === 1 ? 24 : columns === 2 ? 32 : 34,
            y: columns === 1 ? 28 : 52,
            zoom: presentationZoom,
          },
          { duration: 0 },
        );
        return;
      }
      void flow.fitView({
        padding: 0.1,
        minZoom: fitMinimumZoom,
        maxZoom: 1,
      });
    }, 80);
    return () => clearTimeout(timer);
  }, [
    columns,
    features.length,
    fitKey,
    fitMinimumZoom,
    flow,
    presentationZoom,
  ]);

  useEffect(() => {
    if (command === null) return;
    if (command.type === 'zoom-in') void flow.zoomIn();
    if (command.type === 'zoom-out') void flow.zoomOut();
    if (command.type === 'fit') {
      if (columns === 1) {
        void flow.setViewport(
          { x: 24, y: 28, zoom: fitMinimumZoom },
          { duration: 180 },
        );
        return;
      }
      void flow.fitView({
        padding: 0.1,
        minZoom: fitMinimumZoom,
        maxZoom: 1,
      });
    }
  }, [columns, command, fitMinimumZoom, flow]);

  const nodes = useMemo<Node[]>(() => {
    const filesById = new Map(graphNodes.map((node) => [node.id, node]));
    const query = search.trim().toLowerCase();
    const result: Node[] = [];

    let rowTop = 0;
    let rowHeight = 0;
    let columnLeft = 0;

    features.forEach((feature, index) => {
      if (index > 0 && index % columns === 0) {
        rowTop += rowHeight + GAP_Y;
        rowHeight = 0;
        columnLeft = 0;
      }

      const files = feature.memberIds
        .map((fileId) => filesById.get(fileId))
        .filter((file): file is NonNullable<typeof file> => file !== undefined);
      const width = boundaryWidth(files.map((file) => file.path));
      const height = files.length * CELL_H + PAD * 2;
      rowHeight = Math.max(rowHeight, height);

      result.push({
        id: `boundary:${feature.id}`,
        type: 'featureBoundary',
        position: { x: columnLeft, y: rowTop },
        style: { width, height },
        draggable: false,
        connectable: false,
        zIndex: 0,
        data: {
          name: feature.name,
          fileCount: feature.memberIds.length,
          selected: feature.id === selectedFeatureId,
        },
      });

      files.forEach((file, fileIndex) => {
        const matched =
          query.length > 0 &&
          (file.name.toLowerCase().includes(query) ||
            file.path.toLowerCase().includes(query));

        result.push({
          // A file can belong to more than one feature, so the id is scoped.
          id: `${feature.id}:${file.id}`,
          type: 'graphNode',
          position: {
            x: columnLeft + PAD,
            y: rowTop + PAD + fileIndex * CELL_H,
          },
          width: NODE_BOX,
          height: NODE_BOX,
          draggable: false,
          connectable: false,
          zIndex: 1,
          data: {
            name: file.path,
            kind: file.kind,
            isRoot: false,
            selected: file.id === selectedNodeId,
            dimmed: query.length > 0 && !matched,
            matched,
          },
        });
      });

      columnLeft += width + GAP_X;
    });

    return result;
  }, [
    columns,
    features,
    graphNodes,
    search,
    selectedFeatureId,
    selectedNodeId,
  ]);

  return (
    <ReactFlow
      className="mock-flow"
      nodes={nodes}
      edges={[]}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_event, node) => {
        if (node.id.startsWith('boundary:')) {
          onSelectFeature(node.id.slice('boundary:'.length));
          return;
        }
        const [, fileId] = node.id.split(':');
        if (fileId !== undefined) onSelectNode(fileId);
      }}
      fitView
      fitViewOptions={{
        padding: 0.1,
        minZoom: fitMinimumZoom,
        maxZoom: 1,
      }}
      minZoom={0.2}
      maxZoom={2.4}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      {showMinimap && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          maskColor="rgba(19, 20, 18, 0.72)"
          nodeStrokeWidth={14}
          nodeStrokeColor="#55554e"
          nodeColor="#55554e"
        />
      )}
    </ReactFlow>
  );
}

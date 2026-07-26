'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GraphCoverage, NodeKind } from '../types';

export interface GraphNodeData extends Record<string, unknown> {
  name: string;
  kind: NodeKind;
  isRoot: boolean;
  selected: boolean;
  dimmed: boolean;
  matched: boolean;
  coverage?: GraphCoverage;
}

export interface FeatureBoundaryData extends Record<string, unknown> {
  name: string;
  fileCount: number;
  selected: boolean;
}

/**
 * Design system §3: open circle = container, closed dot = leaf, label outside
 * to the right. Handles sit at the node centre so edges run centre-to-centre.
 */
export function GraphNodeView({ data }: NodeProps) {
  const node = data as GraphNodeData;
  const classes = [
    'mock-node',
    node.kind === 'Folder' ? 'mock-node-folder' : 'mock-node-file',
    node.isRoot ? 'mock-node-root' : '',
    node.selected ? 'mock-node-selected' : '',
    node.dimmed ? 'mock-node-dimmed' : '',
    node.matched ? 'mock-node-match' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} className="mock-center-handle" />
      <span className="mock-node-glyph" />
      <span className="mock-node-label">
        {node.name}
        {node.kind === 'File' && node.coverage !== undefined && (
          <span
            className={`mock-coverage mock-coverage-${node.coverage.status}`}
            title={`${node.coverage.coveringTests} covering tests${
              node.coverage.lastRun === null
                ? ''
                : ` · last run ${new Date(node.coverage.lastRun).toLocaleString()}`
            }`}
          >
            {node.coverage.status === 'unknown'
              ? 'unmeasured'
              : node.coverage.status}
          </span>
        )}
      </span>
      <Handle type="source" position={Position.Bottom} className="mock-center-handle" />
    </div>
  );
}

/** Product Tree only: a dashed boundary drawn behind the files it spans. */
export function FeatureBoundaryView({ data }: NodeProps) {
  const boundary = data as FeatureBoundaryData;
  return (
    <div
      className={`mock-feature-boundary${
        boundary.selected ? ' mock-feature-selected' : ''
      }`}
    >
      <span className="mock-feature-label">
        <b>{boundary.name}</b>
        <span>
          {boundary.fileCount} {boundary.fileCount === 1 ? 'file' : 'files'}
        </span>
      </span>
    </div>
  );
}

export const NODE_TYPES = {
  graphNode: GraphNodeView,
  featureBoundary: FeatureBoundaryView,
};

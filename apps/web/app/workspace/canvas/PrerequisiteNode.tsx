'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PrerequisiteProgress } from '../../lib/prerequisiteGraph';

export interface PrerequisiteNodeData extends Record<string, unknown> {
  name: string;
  path: string;
  layer: number;
  progress: PrerequisiteProgress;
  selected: boolean;
  matched: boolean;
  dimmed: boolean;
  /** >1 when this file sits inside a mutually-entangled group. */
  groupSize: number;
}

const PROGRESS_GLYPH: Record<PrerequisiteProgress, string> = {
  done: '✓',
  current: '▸',
  locked: '·',
};

const PROGRESS_LABEL: Record<PrerequisiteProgress, string> = {
  done: 'Read',
  current: 'Ready to read',
  locked: 'Prerequisites outstanding',
};

/**
 * Onboarding reads as a path, so its nodes are ordered cards rather than the
 * Technical tree's containment circles. Anything that looks like a folder tree
 * here would undo the point of the view.
 */
export function PrerequisiteNodeView({ data }: NodeProps) {
  const node = data as PrerequisiteNodeData;
  const classes = [
    'mock-prereq-node',
    `is-${node.progress}`,
    node.selected ? 'is-selected' : '',
    node.matched ? 'is-match' : '',
    node.dimmed ? 'is-dimmed' : '',
    node.groupSize > 1 ? 'is-entangled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} title={node.path}>
      <Handle
        type="target"
        position={Position.Left}
        className="mock-prereq-handle"
      />
      <span className="mock-prereq-state" aria-hidden="true">
        {PROGRESS_GLYPH[node.progress]}
      </span>
      <span className="mock-prereq-body">
        <span className="mock-prereq-name">{node.name}</span>
        <span className="mock-prereq-meta">
          step {node.layer + 1}
          {node.groupSize > 1 ? ` · ${node.groupSize}-file cycle` : ''}
        </span>
      </span>
      <span className="mock-visually-hidden">
        {PROGRESS_LABEL[node.progress]}
      </span>
      <Handle
        type="source"
        position={Position.Right}
        className="mock-prereq-handle"
      />
    </div>
  );
}

export const PREREQUISITE_NODE_TYPES = {
  prerequisite: PrerequisiteNodeView,
};

'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { TechnicalFolderState } from '../technicalExpansion';
import type { GraphCoverage, NodeKind } from '../types';

export interface GraphNodeData extends Record<string, unknown> {
  name: string;
  kind: NodeKind;
  isRoot: boolean;
  selected: boolean;
  dimmed: boolean;
  matched: boolean;
  related?: boolean;
  coverage?: GraphCoverage;
  folderState?: TechnicalFolderState;
  visibleChildCount?: number;
  totalChildCount?: number;
  foldedDescendantCount?: number;
  hiddenImportCount?: number;
  pinned?: boolean;
  onToggleFolder?: (recursive: boolean) => void;
  onTogglePinned?: () => void;
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
    node.related ? 'mock-node-related' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const folderExpanded =
    node.folderState === 'expanded' || node.folderState === 'contextual';
  const folderAction =
    node.folderState === 'collapsed'
      ? 'Expand folder in graph'
      : node.folderState === 'contextual'
        ? 'Collapse contextual folder in graph'
        : 'Collapse folder in graph';
  const foldedCount = node.foldedDescendantCount ?? 0;
  const hiddenImports = node.hiddenImportCount ?? 0;

  return (
    <div className={classes}>
      <Handle
        type="target"
        position={Position.Top}
        className="mock-center-handle"
      />
      {node.kind === 'Folder' &&
      node.folderState !== undefined &&
      node.folderState !== 'leaf' ? (
        <button
          type="button"
          className="mock-node-glyph mock-node-disclosure nodrag nopan"
          aria-label={`${folderAction}: ${node.name}`}
          aria-expanded={folderExpanded}
          title={`${folderAction}. Alt-click to open the full graph.`}
          onClick={(event) => {
            event.stopPropagation();
            node.onToggleFolder?.(event.altKey);
          }}
        />
      ) : (
        <span className="mock-node-glyph" />
      )}
      <span className="mock-node-label">
        {node.name}
        {node.kind === 'Folder' &&
          node.folderState === 'collapsed' &&
          foldedCount > 0 && (
            <span
              className="mock-folder-count"
              title={`${foldedCount} authorized ${
                foldedCount === 1 ? 'descendant' : 'descendants'
              } folded here`}
            >
              +{foldedCount}
            </span>
          )}
        {node.kind === 'Folder' && node.folderState === 'contextual' && (
          <span
            className="mock-folder-count"
            title={`${node.visibleChildCount ?? 0} of ${node.totalChildCount ?? 0} direct children visible`}
          >
            {node.visibleChildCount ?? 0}/{node.totalChildCount ?? 0}
          </span>
        )}
        {node.kind === 'Folder' && hiddenImports > 0 && (
          <span
            className="mock-folder-imports"
            title={`${hiddenImports} authorized import ${
              hiddenImports === 1
                ? 'relationship touches'
                : 'relationships touch'
            } folded content`}
          >
            ↗{hiddenImports}
          </span>
        )}
        {node.kind === 'Folder' && node.onTogglePinned !== undefined && (
          <button
            type="button"
            className="mock-node-pin nodrag nopan"
            aria-label={
              node.pinned
                ? `Unpin ${node.name} from graph`
                : `Pin ${node.name} open in graph`
            }
            aria-pressed={node.pinned}
            title={node.pinned ? 'Unpin branch' : 'Pin branch open'}
            onClick={(event) => {
              event.stopPropagation();
              node.onTogglePinned?.();
            }}
          >
            {node.pinned ? '◆' : '◇'}
          </button>
        )}
        {node.kind === 'File' &&
          node.coverage !== undefined &&
          node.coverage.status !== 'unknown' && (
            <span
              className={`mock-coverage mock-coverage-${node.coverage.status}`}
              title={`${node.coverage.coveringTests} covering tests${
                node.coverage.lastRun === null
                  ? ''
                  : ` · last run ${new Date(node.coverage.lastRun).toLocaleString()}`
              }`}
            >
              {node.coverage.status}
            </span>
          )}
      </span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="mock-center-handle"
      />
    </div>
  );
}

export const NODE_TYPES = {
  graphNode: GraphNodeView,
};

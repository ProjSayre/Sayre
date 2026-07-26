'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import {
  buildFileTreeModel,
  fileTreeAncestorFolders,
  initialFileTreeExpansion,
  visibleFileTreeRows,
  type FileTreeRow,
} from '../fileTree';
import type { LoadStatus, GraphNode } from '../types';

interface FileTreePaneProps {
  hidden: boolean;
  nodes: readonly GraphNode[];
  status: LoadStatus;
  repositoryLabel: string;
  treeKey: string;
  selectedNodeId: string | null;
  pinnedNodeIds: ReadonlySet<string>;
  onSelect: (nodeId: string) => void;
  onTogglePin: (nodeId: string) => void;
  onClose: () => void;
}

function FolderIcon() {
  return (
    <svg className="mock-filetree-node-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.75 4.25h4l1.3 1.5h7.2v7.5H1.75z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="mock-filetree-node-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.25 1.75h6l3.5 3.5v9H3.25z" />
      <path d="M9.25 1.75v3.5h3.5" />
    </svg>
  );
}

export function FileTreePane({
  hidden,
  nodes,
  status,
  repositoryLabel,
  treeKey,
  selectedNodeId,
  pinnedNodeIds,
  onSelect,
  onTogglePin,
  onClose,
}: FileTreePaneProps) {
  const model = useMemo(() => buildFileTreeModel(nodes), [nodes]);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const initializedTreeKey = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (status !== 'ready' || initializedTreeKey.current === treeKey) return;
    initializedTreeKey.current = treeKey;
    setExpandedIds(initialFileTreeExpansion(model));
    setFocusedNodeId(model.roots[0]?.id ?? null);
  }, [model, status, treeKey]);

  useEffect(() => {
    if (selectedNodeId === null || !model.byId.has(selectedNodeId)) return;
    const ancestors = fileTreeAncestorFolders(model, selectedNodeId);
    setExpandedIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const ancestorId of ancestors) {
        if (next.has(ancestorId)) continue;
        next.add(ancestorId);
        changed = true;
      }
      return changed ? next : current;
    });
    setFocusedNodeId(selectedNodeId);
    const timer = window.setTimeout(() => {
      rowRefs.current.get(selectedNodeId)?.scrollIntoView({
        block: 'nearest',
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [model, selectedNodeId]);

  const rows = useMemo(
    () => visibleFileTreeRows(model, expandedIds),
    [expandedIds, model],
  );
  const rowIndex = useMemo(
    () => new Map(rows.map((row, index) => [row.node.id, index])),
    [rows],
  );

  const setExpanded = (nodeId: string, expanded: boolean): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  };

  const activate = (row: FileTreeRow): void => {
    if (row.hasChildren) {
      setExpanded(row.node.id, !expandedIds.has(row.node.id));
    }
    onSelect(row.node.id);
  };

  const focusRow = (row: FileTreeRow | undefined): void => {
    if (row === undefined) return;
    setFocusedNodeId(row.node.id);
    rowRefs.current.get(row.node.id)?.focus();
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: FileTreeRow,
  ): void => {
    const index = rowIndex.get(row.node.id);
    if (index === undefined) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(rows[Math.min(rows.length - 1, index + 1)]);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(rows[Math.max(0, index - 1)]);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusRow(rows[0]);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusRow(rows[rows.length - 1]);
      return;
    }
    if (event.key === 'ArrowRight' && row.hasChildren) {
      event.preventDefault();
      if (!expandedIds.has(row.node.id)) {
        setExpanded(row.node.id, true);
      } else {
        focusRow(rows[index + 1]);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.hasChildren && expandedIds.has(row.node.id)) {
        setExpanded(row.node.id, false);
      } else if (row.parentId !== null) {
        focusRow(rows[rowIndex.get(row.parentId) ?? -1]);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(row);
    }
  };

  const defaultTabStop =
    focusedNodeId !== null && rowIndex.has(focusedNodeId)
      ? focusedNodeId
      : selectedNodeId !== null && rowIndex.has(selectedNodeId)
        ? selectedNodeId
        : rows[0]?.node.id ?? null;
  const selectedNode =
    selectedNodeId === null ? undefined : model.byId.get(selectedNodeId);
  const selectedFolder =
    selectedNode?.kind === 'Folder' &&
    (model.childrenById.get(selectedNode.id)?.length ?? 0) > 0
      ? selectedNode
      : undefined;
  const selectedFolderPinned =
    selectedFolder !== undefined && pinnedNodeIds.has(selectedFolder.id);

  return (
    <aside
      className="mock-filetree"
      aria-label="Repository explorer"
      hidden={hidden}
    >
      <div className="mock-filetree-header">
        <div className="mock-filetree-heading">
          <span>Explorer</span>
          <strong title={repositoryLabel}>{repositoryLabel}</strong>
        </div>
        <button
          type="button"
          className="mock-filetree-action"
          aria-label={
            selectedFolderPinned
              ? 'Unpin selected branch from graph'
              : 'Pin selected branch open in graph'
          }
          title={
            selectedFolderPinned
              ? 'Unpin selected branch from graph'
              : 'Pin selected branch open in graph'
          }
          aria-pressed={selectedFolderPinned}
          disabled={selectedFolder === undefined}
          onClick={() => {
            if (selectedFolder !== undefined) onTogglePin(selectedFolder.id);
          }}
        >
          {selectedFolderPinned ? '◆' : '◇'}
        </button>
        <button
          type="button"
          className="mock-filetree-action"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          disabled={rows.length === 0}
          onClick={() => setExpandedIds(new Set())}
        >
          ⇤
        </button>
        <button
          type="button"
          className="mock-filetree-action"
          aria-label="Close repository explorer"
          title="Close repository explorer"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {status === 'loading' || status === 'idle' ? (
        <div className="mock-filetree-state" role="status">
          Loading authorized files…
        </div>
      ) : status === 'error' ? (
        <div className="mock-filetree-state" role="alert">
          Repository tree unavailable.
        </div>
      ) : rows.length === 0 ? (
        <div className="mock-filetree-state">No authorized files.</div>
      ) : (
        <div
          className="mock-filetree-rows"
          role="tree"
          aria-label={`${repositoryLabel} files`}
        >
          {rows.map((row) => {
            const expanded = expandedIds.has(row.node.id);
            const selected = row.node.id === selectedNodeId;
            const displayName =
              row.node.parentId === null ? repositoryLabel : row.node.name;
            return (
              <button
                key={row.node.id}
                ref={(element) => {
                  if (element === null) rowRefs.current.delete(row.node.id);
                  else rowRefs.current.set(row.node.id, element);
                }}
                type="button"
                role="treeitem"
                className="mock-filetree-row"
                style={
                  {
                    '--filetree-depth': row.depth,
                  } as CSSProperties
                }
                title={row.node.path}
                aria-level={row.depth + 1}
                aria-posinset={row.positionInSet}
                aria-setsize={row.setSize}
                aria-selected={selected}
                aria-expanded={row.hasChildren ? expanded : undefined}
                tabIndex={row.node.id === defaultTabStop ? 0 : -1}
                onFocus={() => setFocusedNodeId(row.node.id)}
                onClick={() => activate(row)}
                onKeyDown={(event) => handleKeyDown(event, row)}
              >
                <span className="mock-filetree-chevron" aria-hidden="true">
                  {row.hasChildren ? (expanded ? '⌄' : '›') : ''}
                </span>
                {row.node.kind === 'Folder' ? <FolderIcon /> : <FileIcon />}
                <span className="mock-filetree-name">{displayName}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="mock-filetree-footer">
        {nodes.length.toLocaleString()} authorized nodes
      </div>
    </aside>
  );
}

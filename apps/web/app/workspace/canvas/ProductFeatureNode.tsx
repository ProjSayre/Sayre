'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type {
  ProductClusterDirectory,
  ProductFeatureCluster,
} from './productGraph';

export interface ProductFeatureNodeData extends Record<string, unknown> {
  cluster: ProductFeatureCluster;
  selected: boolean;
  containsSelectedFile: boolean;
  dimmed: boolean;
  matched: boolean;
  selectedNodeId: string | null;
  matchedFileIds: string[];
  openDirectoryId: string | null;
  onSelectFeature: () => void;
  onSelectFile: (fileId: string) => void;
  onToggleDirectory: (directoryId: string) => void;
  onCloseDirectory: () => void;
}

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function codeAreaCountLabel(count: number): string {
  return `${count} code ${count === 1 ? 'area' : 'areas'}`;
}

function DirectoryFlyout({
  directory,
  selectedNodeId,
  onSelectFile,
  onClose,
}: {
  directory: ProductClusterDirectory;
  selectedNodeId: string | null;
  onSelectFile: (fileId: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="mock-feature-flyout nodrag nopan"
      role="dialog"
      aria-label={`Files in ${directory.path}`}
      // Anchored to the directory's own caption row inside the block, so the
      // full list opens exactly where the truncated blocks were.
      style={{
        left: directory.x,
        top: directory.y,
        width: directory.width,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mock-feature-flyout-path">
        <span>{directory.path}/</span>
        <button
          type="button"
          aria-label="Close directory files"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="mock-feature-flyout-files">
        {directory.files.map((file) => (
          <button
            key={file.id}
            type="button"
            className={
              file.id === selectedNodeId
                ? 'mock-feature-flyout-row is-selected'
                : 'mock-feature-flyout-row'
            }
            title={file.path}
            onClick={() => {
              onSelectFile(file.id);
              onClose();
            }}
          >
            <span className="mock-feature-flyout-dot" />
            {file.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProductFeatureNode({ data }: NodeProps) {
  const node = data as ProductFeatureNodeData;
  const { cluster } = node;
  const matchedFileIds = new Set(node.matchedFileIds);
  const openDirectory = cluster.directories.find(
    ({ id }) => id === node.openDirectoryId,
  );
  const classes = [
    'mock-feature-block',
    node.selected ? 'is-selected' : '',
    node.containsSelectedFile ? 'has-selected-file' : '',
    node.dimmed ? 'is-dimmed' : '',
    node.matched ? 'is-matched' : '',
    openDirectory !== undefined ? 'has-open-directory' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      style={{
        width: cluster.width,
        height: cluster.height,
      }}
    >
      {/* Pinned to the block's left and right edges so feature links run
          between the frames rather than out of their centres. */}
      <Handle
        type="target"
        position={Position.Left}
        className="mock-feature-handle"
        style={{ left: 0, top: cluster.height / 2 }}
      />
      {/*
        The frame is the feature's own click target and sits behind everything
        else, so clicking anywhere that isn't a file block or a directory
        caption selects the feature. The header above it is inert text.
      */}
      <button
        type="button"
        className="mock-feature-frame nodrag nopan"
        aria-label={`Open feature ${cluster.name}`}
        aria-pressed={node.selected}
        title={cluster.description ?? cluster.name}
        onClick={(event) => {
          event.stopPropagation();
          node.onSelectFeature();
        }}
      />

      <div className="mock-feature-header" aria-hidden="true">
        <strong>{cluster.name}</strong>
        <span>
          {fileCountLabel(cluster.fileCount)} ·{' '}
          {codeAreaCountLabel(cluster.workspaceCount)}
        </span>
        {cluster.team !== null && <em>{cluster.team}</em>}
      </div>

      {cluster.directories.map((directory) => {
        const isOpen = directory.id === node.openDirectoryId;
        return (
          <div key={directory.id}>
            <button
              type="button"
              className={`mock-feature-directory nodrag nopan${
                isOpen ? ' is-open' : ''
              }`}
              style={{
                left: directory.x,
                top: directory.y,
                width: directory.width,
              }}
              aria-label={`Show files in ${directory.path}`}
              aria-expanded={isOpen}
              title={`${directory.path}/ · ${fileCountLabel(directory.files.length)}`}
              onClick={(event) => {
                event.stopPropagation();
                node.onToggleDirectory(directory.id);
              }}
            >
              <span className="mock-feature-directory-label">
                {directory.label}
              </span>
              {directory.hiddenFileCount > 0 && (
                <span className="mock-feature-directory-count">
                  +{directory.hiddenFileCount}
                </span>
              )}
            </button>
            {directory.files
              .slice(0, directory.visibleFileCount)
              .map((file) => (
              <button
                key={file.id}
                type="button"
                className={[
                  'mock-feature-file nodrag nopan',
                  file.id === node.selectedNodeId ? 'is-selected' : '',
                  matchedFileIds.has(file.id) ? 'is-matched' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  left: file.x,
                  top: file.y,
                  width: file.width,
                  height: file.height,
                }}
                aria-label={`Open file ${file.path}`}
                title={file.path}
                onClick={(event) => {
                  event.stopPropagation();
                  node.onSelectFile(file.id);
                }}
              >
                <span className="mock-feature-file-name">{file.name}</span>
              </button>
              ))}
          </div>
        );
      })}

      {cluster.hiddenDirectoryCount > 0 && (
        <span
          className="mock-feature-overflow"
          title={`${cluster.hiddenDirectoryCount} additional code ${
            cluster.hiddenDirectoryCount === 1 ? 'area is' : 'areas are'
          } listed in feature details`}
        >
          +{cluster.hiddenDirectoryCount}{' '}
          {cluster.hiddenDirectoryCount === 1 ? 'area' : 'areas'}
        </span>
      )}

      {openDirectory !== undefined && (
        <DirectoryFlyout
          directory={openDirectory}
          selectedNodeId={node.selectedNodeId}
          onSelectFile={node.onSelectFile}
          onClose={node.onCloseDirectory}
        />
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="mock-feature-handle"
        style={{ left: cluster.width, top: cluster.height / 2 }}
      />
    </div>
  );
}

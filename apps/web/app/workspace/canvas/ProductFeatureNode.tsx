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
  cluster,
  directory,
  selectedNodeId,
  onSelectFile,
  onClose,
}: {
  cluster: ProductFeatureCluster;
  directory: ProductClusterDirectory;
  selectedNodeId: string | null;
  onSelectFile: (fileId: string) => void;
  onClose: () => void;
}) {
  const opensLeft = directory.x > 0;
  return (
    <div
      className="mock-feature-flyout nodrag nopan"
      role="dialog"
      aria-label={`Files in ${directory.path}`}
      style={{
        left: cluster.radius + directory.x + (opensLeft ? -252 : 16),
        top: Math.max(
          8,
          Math.min(
            cluster.radius + directory.y - 18,
            cluster.diameter - 154,
          ),
        ),
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
    'mock-feature-cluster',
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
        width: cluster.diameter,
        height: cluster.diameter,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="mock-feature-handle"
        style={{ left: 0, top: cluster.radius }}
      />
      <button
        type="button"
        className="mock-feature-ring nodrag nopan"
        aria-label={`Open feature ${cluster.name}`}
        aria-pressed={node.selected}
        title={cluster.description ?? cluster.name}
        onClick={(event) => {
          event.stopPropagation();
          node.onSelectFeature();
        }}
      />

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
                left: cluster.radius + directory.x,
                top: cluster.radius + directory.y,
              }}
              aria-label={`Show files in ${directory.path}`}
              aria-expanded={isOpen}
              title={`${directory.path}/ · ${fileCountLabel(directory.files.length)}`}
              onClick={(event) => {
                event.stopPropagation();
                node.onToggleDirectory(directory.id);
              }}
            >
              <span className="mock-feature-directory-ring" />
              <span className="mock-feature-directory-label">
                {directory.label}
              </span>
              {directory.hiddenFileCount > 0 && (
                <span
                  className="mock-feature-directory-count"
                  aria-hidden="true"
                >
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
                  left: cluster.radius + file.x,
                  top: cluster.radius + file.y,
                }}
                aria-label={`Open file ${file.path}`}
                title={file.path}
                onClick={(event) => {
                  event.stopPropagation();
                  node.onSelectFile(file.id);
                }}
              />
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

      <button
        type="button"
        className="mock-feature-cluster-label nodrag nopan"
        style={{ left: 0, top: cluster.diameter + 9 }}
        onClick={(event) => {
          event.stopPropagation();
          node.onSelectFeature();
        }}
      >
        <strong>{cluster.name}</strong>
        <span>
          {fileCountLabel(cluster.fileCount)} ·{' '}
          {codeAreaCountLabel(cluster.workspaceCount)}
        </span>
        {cluster.team !== null && <em>{cluster.team}</em>}
      </button>

      {openDirectory !== undefined && (
        <DirectoryFlyout
          cluster={cluster}
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
        style={{ left: cluster.diameter, top: cluster.radius }}
      />
    </div>
  );
}

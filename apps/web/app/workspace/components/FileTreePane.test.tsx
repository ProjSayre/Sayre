import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '../types';

(globalThis as unknown as { React: typeof React }).React = React;

import { FileTreePane } from './FileTreePane';

const nodes: GraphNode[] = [
  {
    id: 'root',
    kind: 'Folder',
    name: 'repository',
    path: '',
    parentId: null,
  },
  {
    id: 'src',
    kind: 'Folder',
    name: 'src',
    path: 'src',
    parentId: 'root',
  },
  {
    id: 'index',
    kind: 'File',
    name: 'index.ts',
    path: 'src/index.ts',
    parentId: 'src',
  },
];

function renderExplorer(expandedFolderIds: ReadonlySet<string>): string {
  return renderToStaticMarkup(
    <FileTreePane
      hidden={false}
      nodes={nodes}
      status="ready"
      repositoryLabel="repository/"
      selectedNodeId={null}
      expandedFolderIds={expandedFolderIds}
      pinnedNodeIds={new Set()}
      onSelect={vi.fn()}
      onSetFolderExpanded={vi.fn()}
      onCollapseAll={vi.fn()}
      onTogglePin={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe('FileTreePane expansion synchronization', () => {
  it('renders rows from the graph-owned expanded-folder projection', () => {
    const rootOnly = renderExplorer(new Set(['root']));
    expect(rootOnly).toContain('aria-expanded="true"');
    expect(rootOnly).toContain('src');
    expect(rootOnly).not.toContain('index.ts');

    const rootAndSource = renderExplorer(new Set(['root', 'src']));
    expect(rootAndSource).toContain('index.ts');
    expect(rootAndSource.match(/aria-expanded="true"/g)).toHaveLength(2);

    const collapsed = renderExplorer(new Set());
    expect(collapsed).not.toContain('src');
    expect(collapsed).not.toContain('index.ts');
  });
});

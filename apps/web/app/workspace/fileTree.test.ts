import { describe, expect, it } from 'vitest';
import type { GraphNode } from './types';
import {
  buildFileTreeModel,
  fileTreeAncestorFolders,
  initialFileTreeExpansion,
  matchingFileTreeNodeIds,
  searchedFileTreeRows,
  visibleFileTreeRows,
} from './fileTree';

const nodes: GraphNode[] = [
  {
    id: 'root',
    kind: 'Folder',
    name: '/',
    path: '/',
    parentId: null,
  },
  {
    id: 'apps',
    kind: 'Folder',
    name: 'apps',
    path: 'apps',
    parentId: 'root',
  },
  {
    id: 'file-10',
    kind: 'File',
    name: 'file10.ts',
    path: 'apps/file10.ts',
    parentId: 'apps',
  },
  {
    id: 'file-2',
    kind: 'File',
    name: 'file2.ts',
    path: 'apps/file2.ts',
    parentId: 'apps',
  },
  {
    id: 'orphan',
    kind: 'File',
    name: 'visible.ts',
    path: 'hidden/visible.ts',
    parentId: 'rbac-hidden-parent',
  },
];

describe('file tree projection', () => {
  it('preserves authorized orphans as roots and sorts folders before files', () => {
    const model = buildFileTreeModel(nodes);

    expect(model.roots.map((node) => node.id)).toEqual(['root', 'orphan']);
    expect(model.childrenById.get('apps')?.map((node) => node.id)).toEqual([
      'file-2',
      'file-10',
    ]);
  });

  it('initially expands only rooted folders', () => {
    const model = buildFileTreeModel(nodes);

    expect([...initialFileTreeExpansion(model)]).toEqual(['root']);
    expect(
      visibleFileTreeRows(model, initialFileTreeExpansion(model)).map(
        ({ node }) => node.id,
      ),
    ).toEqual(['root', 'apps', 'orphan']);
  });

  it('reveals a selected node path when its ancestor folders are expanded', () => {
    const model = buildFileTreeModel(nodes);
    const expanded = new Set([
      ...initialFileTreeExpansion(model),
      ...fileTreeAncestorFolders(model, 'file-2'),
    ]);

    expect([...fileTreeAncestorFolders(model, 'file-2')]).toEqual([
      'apps',
      'root',
    ]);
    expect(
      visibleFileTreeRows(model, expanded).map(({ node, depth }) => [
        node.id,
        depth,
      ]),
    ).toEqual([
      ['root', 0],
      ['apps', 1],
      ['file-2', 2],
      ['file-10', 2],
      ['orphan', 0],
    ]);
  });

  it('keeps malformed cycles finite and visible', () => {
    const cyclic: GraphNode[] = [
      {
        id: 'a',
        kind: 'Folder',
        name: 'a',
        path: 'a',
        parentId: 'b',
      },
      {
        id: 'b',
        kind: 'Folder',
        name: 'b',
        path: 'b',
        parentId: 'a',
      },
    ];
    const model = buildFileTreeModel(cyclic);
    const rows = visibleFileTreeRows(model, new Set(['a', 'b']));

    expect(rows.map(({ node }) => node.id)).toEqual(['a', 'b']);
    expect(fileTreeAncestorFolders(model, 'a').size).toBe(1);
  });

  it('shows deep search matches with their authorized ancestor chain', () => {
    const model = buildFileTreeModel(nodes);
    const matches = matchingFileTreeNodeIds(model, 'file2');
    const rows = searchedFileTreeRows(model, matches);

    expect([...matches]).toEqual(['file-2']);
    expect(rows.map(({ node }) => node.id)).toEqual([
      'root',
      'apps',
      'file-2',
    ]);
    expect(rows.map(({ depth }) => depth)).toEqual([0, 1, 2]);
  });
});

import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../types';
import { layoutRadialTree, layoutTree } from './layout';

const nodes: GraphNode[] = [
  {
    id: 'root',
    kind: 'Folder',
    name: '/',
    path: '',
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
    id: 'packages',
    kind: 'Folder',
    name: 'packages',
    path: 'packages',
    parentId: 'root',
  },
  {
    id: 'web',
    kind: 'File',
    name: 'page.tsx',
    path: 'apps/web/page.tsx',
    parentId: 'apps',
  },
  {
    id: 'core',
    kind: 'File',
    name: 'index.ts',
    path: 'packages/core/index.ts',
    parentId: 'packages',
  },
];

describe('workspace graph layouts', () => {
  it('keeps the approved small tree in ordered rows', () => {
    const positions = layoutTree(nodes);

    expect(positions).toHaveLength(nodes.length);
    expect(positions.get('root')?.y).toBe(0);
    expect(positions.get('apps')?.y).toBeGreaterThan(0);
    expect(positions.get('web')?.y).toBeGreaterThan(
      positions.get('apps')?.y ?? 0,
    );
  });

  it('fans a large-renderer hierarchy around the root instead of one stripe', () => {
    const positions = layoutRadialTree(nodes, 'landscape');
    const root = positions.get('root');
    const leafPoints = ['web', 'core'].map((id) => positions.get(id));

    expect(positions).toHaveLength(nodes.length);
    expect(root).toEqual({ x: 0, y: 0 });
    expect(new Set(leafPoints.map((point) => point?.x))).toHaveLength(2);
    expect(new Set(leafPoints.map((point) => point?.y))).toHaveLength(2);
  });

  it('places orphaned authorized nodes as additional roots', () => {
    const orphan: GraphNode = {
      id: 'orphan',
      kind: 'File',
      name: 'orphan.ts',
      path: 'orphan.ts',
      parentId: 'not-authorized',
    };

    expect(layoutRadialTree([...nodes, orphan]).has(orphan.id)).toBe(true);
  });
});

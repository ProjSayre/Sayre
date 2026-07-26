import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../types';
import { layoutScalableTree, layoutTree } from './layout';

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
    expect(positions.get('packages')?.y).toBe(
      positions.get('apps')?.y,
    );
  });

  it('keeps the large renderer in the approved top-down hierarchy', () => {
    const positions = layoutScalableTree(nodes, 'landscape');
    const root = positions.get('root');
    const leafPoints = ['web', 'core'].map((id) => positions.get(id));

    expect(positions).toHaveLength(nodes.length);
    expect(root?.y).toBe(0);
    expect(new Set(leafPoints.map((point) => point?.x))).toHaveLength(2);
    expect(new Set(leafPoints.map((point) => point?.y))).toHaveLength(1);
    expect(leafPoints[0]?.y).toBeLessThan(
      positions.get('apps')?.y ?? 0,
    );
  });

  it('scales row spacing with a wide repository instead of flattening it', () => {
    const wideNodes: GraphNode[] = [
      nodes[0],
      nodes[1],
      ...Array.from({ length: 120 }, (_, index): GraphNode => ({
        id: `leaf-${index}`,
        kind: 'File',
        name: `file-${index}.ts`,
        path: `apps/file-${index}.ts`,
        parentId: 'apps',
      })),
    ];
    const positions = layoutScalableTree(wideNodes, 'landscape');
    const points = [...positions.values()];
    const width =
      Math.max(...points.map(({ x }) => x)) -
      Math.min(...points.map(({ x }) => x));
    const height =
      Math.max(...points.map(({ y }) => y)) -
      Math.min(...points.map(({ y }) => y));

    expect(width / height).toBeGreaterThan(1.65);
    expect(width / height).toBeLessThan(1.85);
  });

  it('places orphaned authorized nodes as additional roots', () => {
    const orphan: GraphNode = {
      id: 'orphan',
      kind: 'File',
      name: 'orphan.ts',
      path: 'orphan.ts',
      parentId: 'not-authorized',
    };

    expect(layoutTree([...nodes, orphan]).has(orphan.id)).toBe(true);
    expect(layoutScalableTree([...nodes, orphan]).has(orphan.id)).toBe(true);
  });
});

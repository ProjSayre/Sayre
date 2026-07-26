import { describe, expect, it } from 'vitest';
import type { Feature, GraphEdge, GraphNode } from '../types';
import {
  buildProductFeatureClusters,
  buildProductFeatureConnections,
  layoutProductFeatureClusters,
} from './productGraph';

const nodes: GraphNode[] = [
  {
    id: 'checkout-page',
    kind: 'File',
    name: 'CheckoutPage.tsx',
    path: 'apps/web/src/checkout/CheckoutPage.tsx',
    parentId: null,
  },
  {
    id: 'price',
    kind: 'File',
    name: 'Price.tsx',
    path: 'packages/ui/src/Price.tsx',
    parentId: null,
  },
  {
    id: 'button',
    kind: 'File',
    name: 'Button.tsx',
    path: 'packages/ui/src/Button.tsx',
    parentId: null,
  },
];

const features: Feature[] = [
  {
    id: 'checkout',
    name: 'Checkout',
    description: null,
    team: 'Commerce',
    memberIds: ['checkout-page', 'price'],
    recentEdits: [],
  },
  {
    id: 'design-system',
    name: 'Design system',
    description: null,
    team: 'UI',
    memberIds: ['price', 'button'],
    recentEdits: [],
  },
];

describe('Product feature graph', () => {
  it('bundles authorized files by their path-derived directory', () => {
    const clusters = buildProductFeatureClusters(nodes, features);

    expect(clusters[0]).toMatchObject({
      id: 'checkout',
      fileCount: 2,
      workspaceCount: 2,
    });
    expect(clusters[0]?.directories.map(({ path }) => path)).toEqual([
      'apps/web/src/checkout',
      'packages/ui/src',
    ]);
    expect(clusters[0]?.directories[1]?.label).toBe('ui/src/');
    expect(
      clusters.flatMap(({ directories }) =>
        directories.flatMap(({ files }) => files.map(({ id }) => id)),
      ),
    ).toEqual(['checkout-page', 'price', 'button', 'price']);
  });

  it('connects shared membership and authorized cross-feature imports', () => {
    const edges: GraphEdge[] = [
      {
        id: 'imports-checkout-button',
        type: 'IMPORTS',
        source: 'checkout-page',
        target: 'button',
      },
      {
        id: 'contains-ignored',
        type: 'CONTAINS',
        source: 'checkout-page',
        target: 'price',
      },
    ];

    expect(buildProductFeatureConnections(features, edges)).toEqual([
      {
        id: 'feature-link:checkout:design-system',
        sourceFeatureId: 'checkout',
        targetFeatureId: 'design-system',
        sharedFileIds: ['price'],
        dependencyCount: 1,
      },
    ]);
  });

  it('keeps connected feature clusters adjacent in a stable layout', () => {
    const clusters = buildProductFeatureClusters(nodes, features);
    const connections = buildProductFeatureConnections(features, []);
    const placements = layoutProductFeatureClusters(clusters, connections, 4);

    expect(placements).toHaveLength(2);
    expect(placements[0]?.y).toBe(placements[1]?.y);
    expect(placements[0]?.x).toBeLessThan(placements[1]?.x ?? 0);
  });
});

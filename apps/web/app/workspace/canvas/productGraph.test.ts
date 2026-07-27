import { describe, expect, it } from 'vitest';
import type { Feature, GraphEdge, GraphNode } from '../types';
import {
  MAX_VISIBLE_FEATURE_DIRECTORIES,
  MAX_VISIBLE_FILES_PER_DIRECTORY,
  buildProductFeatureClusters,
  buildProductFeatureConnections,
  layoutProductFeatureClusters,
  productFeatureFocus,
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
        sourceToTargetDependencyCount: 1,
        targetToSourceDependencyCount: 0,
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

  it('bounds visual detail without losing exact feature totals', () => {
    const largeNodes: GraphNode[] = Array.from(
      { length: 20 * 15 },
      (_, index) => {
        const directory = Math.floor(index / 15);
        return {
          id: `file-${index}`,
          kind: 'File' as const,
          name: `file-${index}.ts`,
          path: `services/core/area-${directory}/file-${index}.ts`,
          parentId: null,
        };
      },
    );
    const [cluster] = buildProductFeatureClusters(largeNodes, [{
      id: 'large',
      name: 'Large feature',
      description: null,
      team: null,
      memberIds: largeNodes.map(({ id }) => id),
      recentEdits: [],
    }]);

    expect(cluster).toMatchObject({
      fileCount: 300,
      directoryCount: 20,
      hiddenDirectoryCount: 12,
    });
    expect(cluster?.directories).toHaveLength(MAX_VISIBLE_FEATURE_DIRECTORIES);
    expect(
      cluster?.directories.every(
        ({ visibleFileCount }) =>
          visibleFileCount === MAX_VISIBLE_FILES_PER_DIRECTORY,
      ),
    ).toBe(true);
  });

  it('focuses only the selected feature, its neighbors, and incident edges', () => {
    const connections = [
      {
        id: 'a-b',
        sourceFeatureId: 'a',
        targetFeatureId: 'b',
        sharedFileIds: [],
        dependencyCount: 1,
        sourceToTargetDependencyCount: 1,
        targetToSourceDependencyCount: 0,
      },
      {
        id: 'b-c',
        sourceFeatureId: 'b',
        targetFeatureId: 'c',
        sharedFileIds: [],
        dependencyCount: 1,
        sourceToTargetDependencyCount: 1,
        targetToSourceDependencyCount: 0,
      },
    ];

    const focus = productFeatureFocus('a', connections);

    expect([...(focus?.adjacentFeatureIds ?? [])]).toEqual(['a', 'b']);
    expect([...(focus?.activeConnectionIds ?? [])]).toEqual(['a-b']);
  });
});

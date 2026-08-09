/**
 * FE-ARCH-02 tester-added coverage — non-behavioral stress exercises of the shape adapters' already-
 * fixed purity contract (AC-13's "is pure" case) and EC-05's tree-integrity claim (every Folder/File
 * node emitted exactly once, parentId preserved, graph-internal kinds excluded), re-run at a scale and
 * with string content no red case tries. Nothing here decides a new mapping rule; every assertion
 * checks a rule shapeAdapters.red.test.ts already pinned. Per .sdd/stages/tester.md this file adds
 * only non-behavioral coverage.
 */
import { describe, expect, it } from 'vitest';
import { isWorkspaceShapePayload } from '../../../../../packages/workspace-packs/src/runtime';
import type { Feature, GraphNode } from '../types';
import { featuresCollectionPayload, structureTreePayload } from './shapeAdapters';

/** A wide, deep synthetic tree: `width` children per level, `depth` levels, Folder/File alternating. */
function largeTree(depth: number, width: number): GraphNode[] {
  const nodes: GraphNode[] = [];
  let counter = 0;
  function build(parentId: string | null, level: number): void {
    if (level > depth) return;
    for (let i = 0; i < width; i += 1) {
      const id = `node-${counter}`;
      counter += 1;
      const isFolder = level < depth;
      nodes.push({
        id,
        kind: isFolder ? 'Folder' : 'File',
        name: `entry-${id}`,
        path: `${parentId ?? 'root'}/${id}`,
        parentId,
      });
      if (isFolder) build(id, level + 1);
    }
  }
  build(null, 0);
  return nodes;
}

function graphInternalNoise(count: number): GraphNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `internal-${index}`,
    kind: 'Function',
    name: `fn${index}`,
    path: `src/fn${index}.ts#fn${index}`,
    parentId: null,
  })) as unknown as GraphNode[];
}

function largeFeatureSet(count: number): Feature[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `feature-${index}`,
    name: `Feature ${index}`,
    description: index % 3 === 0 ? null : `Description for feature ${index}`,
    team: index % 5 === 0 ? null : `Team ${index % 5}`,
    memberIds: [`node-${index}`],
    recentEdits: [],
  }));
}

describe('FE-ARCH-02 tester coverage — shape adapters under stress', () => {
  // EC-05's "every Folder/File node exactly once, parentId preserved" claim, re-run against a deep,
  // wide tree (several hundred nodes) instead of the four-node fixture shapeAdapters.red.test.ts uses.
  it('emits every Folder/File node exactly once with parentId preserved, at scale, mixed with graph-internal noise', () => {
    const tree = largeTree(5, 4); // depth 5, width 4 -> hundreds of Folder/File nodes
    const noise = graphInternalNoise(200);
    const input = [...tree, ...noise];

    const payload = structureTreePayload(input);

    expect(payload.nodes).toHaveLength(tree.length);
    const byId = new Map(payload.nodes.map((node) => [node.id, node]));
    expect(byId.size).toBe(tree.length);
    for (const original of tree) {
      const emitted = byId.get(original.id);
      expect(emitted).toBeDefined();
      expect(emitted?.parentId).toBe(original.parentId);
      expect(emitted?.label).toBe(original.name);
      expect(emitted?.kind).toBe(original.kind);
    }
    // No graph-internal id leaked through.
    expect(payload.nodes.some((node) => node.id.startsWith('internal-'))).toBe(false);
    expect(isWorkspaceShapePayload('tree', payload)).toBe(true);
  });

  // AC-13's purity claim, re-run at scale with a large fixture and repeated calls, including a
  // structurally frozen input to catch accidental in-place writes the small red fixture wouldn't.
  it('is pure at scale: repeated calls over a large frozen fixture produce identical output and mutate nothing', () => {
    const tree = largeTree(4, 5);
    const frozenTree = tree.map((node) => Object.freeze({ ...node })) as GraphNode[];
    const before = JSON.stringify(frozenTree);

    const first = structureTreePayload(frozenTree);
    const second = structureTreePayload(frozenTree);
    expect(second).toEqual(first);
    expect(JSON.stringify(frozenTree)).toBe(before);

    const features = largeFeatureSet(300).map((feature) => Object.freeze(feature));
    const nodePaths = new Map(tree.map((node) => [node.id, node.path]));
    const nodePathsBefore = [...nodePaths.entries()];
    const featuresBefore = JSON.stringify(features);

    const firstCollection = featuresCollectionPayload(features, nodePaths);
    const secondCollection = featuresCollectionPayload(features, nodePaths);
    expect(secondCollection).toEqual(firstCollection);
    expect(JSON.stringify(features)).toBe(featuresBefore);
    expect([...nodePaths.entries()]).toEqual(nodePathsBefore);
    expect(isWorkspaceShapePayload('collection', firstCollection)).toBe(true);
  });

  // Same already-fixed EC-05/AC-13 mapping contract, exercised with unicode and very long strings in
  // node names/feature names/descriptions instead of the short ASCII fixtures red uses — the produced
  // payload must still satisfy the frozen shape guard.
  it('handles unicode and very long strings in node and feature fields, and still satisfies the shape guard', () => {
    const unicodeString = '仕様書 — spécification 🚀 مواصفة';
    const longString = 'n'.repeat(5000);

    const nodes: GraphNode[] = [
      { id: 'node.root', kind: 'Folder', name: unicodeString, path: 'src', parentId: null },
      { id: 'node.file', kind: 'File', name: longString, path: 'src/file', parentId: 'node.root' },
    ];
    const treePayload = structureTreePayload(nodes);
    expect(treePayload.nodes.find((node) => node.id === 'node.root')?.label).toBe(unicodeString);
    expect(treePayload.nodes.find((node) => node.id === 'node.file')?.label).toBe(longString);
    expect(isWorkspaceShapePayload('tree', treePayload)).toBe(true);

    const features: Feature[] = [
      { id: 'feature.unicode', name: unicodeString, description: longString, team: unicodeString, memberIds: [], recentEdits: [] },
    ];
    const collectionPayload = featuresCollectionPayload(features, new Map());
    expect(collectionPayload.items[0]?.title).toBe(unicodeString);
    expect(isWorkspaceShapePayload('collection', collectionPayload)).toBe(true);
  });
});

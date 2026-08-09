/**
 * FE-ARCH-02 red suite — the shape adapters that map already server-authorized workspace query
 * state into canonical shape payloads.
 *
 * Authored from .pipeline/spec.md before `apps/web/app/workspace/packs/shapeAdapters.ts` exists.
 * Both the adapters and the frozen payload guard are loaded through guarded dynamic imports, the
 * convention this repository already uses for leading-red suites, so a missing implementation fails
 * as a named assertion per test rather than as a module-resolution crash.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Feature, GraphNode } from '../types';

type ShapeId = 'collection' | 'tree' | 'graph' | 'document';

interface TreeNode { id: string; parentId: string | null; label: string; kind: string }
interface TreePayload { shape: 'tree'; nodes: readonly TreeNode[] }
interface CollectionItem {
  id: string; title: string; subtitle?: string; group?: string;
  status?: string; timestamp?: string;
  ref?: { kind: 'node' | 'feature' | 'external'; id: string };
}
interface CollectionPayload { shape: 'collection'; items: readonly CollectionItem[]; groups?: readonly { id: string; label: string }[] }

interface ShapeAdaptersModule {
  structureTreePayload(nodes: readonly GraphNode[]): TreePayload;
  featuresCollectionPayload(features: readonly Feature[], nodePaths: ReadonlyMap<string, string>): CollectionPayload;
}

interface ShapesModule {
  isWorkspaceShapePayload(shape: ShapeId, value: unknown): boolean;
}

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'apps/web/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

async function loadAdapters(): Promise<ShapeAdaptersModule> {
  const path = resolve(repositoryRoot(), 'apps/web/app/workspace/packs/shapeAdapters.ts');
  expect(
    existsSync(path),
    'FE-ARCH-02 shape adapters are not implemented yet: apps/web/app/workspace/packs/shapeAdapters.ts',
  ).toBe(true);
  return vi.importActual<ShapeAdaptersModule>('./shapeAdapters');
}

async function loadShapes(): Promise<ShapesModule> {
  const path = resolve(repositoryRoot(), 'packages/workspace-packs/src/shapes.ts');
  expect(
    existsSync(path),
    'FE-ARCH-02 shape contract is not implemented yet: packages/workspace-packs/src/shapes.ts',
  ).toBe(true);
  return vi.importActual<ShapesModule>('../../../../../packages/workspace-packs/src/shapes');
}

/** Folder and File nodes exactly as the existing workspace queries deliver them. */
function renderableNodes(): GraphNode[] {
  return [
    { id: 'node.root', kind: 'Folder', name: 'src', path: 'src', parentId: null },
    { id: 'node.app', kind: 'Folder', name: 'app', path: 'src/app', parentId: 'node.root' },
    { id: 'node.page', kind: 'File', name: 'page.tsx', path: 'src/app/page.tsx', parentId: 'node.app' },
    { id: 'node.readme', kind: 'File', name: 'README.md', path: 'README.md', parentId: null },
  ];
}

/**
 * Graph-internal kinds that must never reach a canvas payload. The workspace `GraphNode` type admits
 * only Folder/File, so the cast is what lets this test exercise the runtime exclusion the
 * architecture rule requires rather than relying on the type alone.
 */
function graphInternalNodes(): GraphNode[] {
  return [
    { id: 'fn.render', kind: 'Function', name: 'render', path: 'src/app/page.tsx#render', parentId: 'node.page' },
    { id: 'class.shell', kind: 'Class', name: 'Shell', path: 'src/app/page.tsx#Shell', parentId: 'node.page' },
    { id: 'other.thing', kind: 'Symbol', name: 'thing', path: 'src/app/page.tsx#thing', parentId: 'node.page' },
  ] as unknown as GraphNode[];
}

function featureFixture(): Feature[] {
  return [
    { id: 'feature.checkout', name: 'Checkout', description: 'Cart to receipt.', team: 'Payments', memberIds: ['node.page'], recentEdits: [] },
    { id: 'feature.search', name: 'Search', description: null, team: null, memberIds: [], recentEdits: [] },
  ];
}

function nodePathFixture(): Map<string, string> {
  return new Map(renderableNodes().map((node) => [node.id, node.path]));
}

describe('FE-ARCH-02 workspace shape adapters', () => {
  // @spec EC-05
  it('emits every Folder and File node exactly once with its parent preserved', async () => {
    const { structureTreePayload } = await loadAdapters();
    const payload = structureTreePayload(renderableNodes());

    expect(payload.shape).toBe('tree');
    expect(payload.nodes).toHaveLength(4);
    const byId = new Map(payload.nodes.map((node) => [node.id, node]));
    expect([...byId.keys()].sort()).toEqual(['node.app', 'node.page', 'node.readme', 'node.root']);
    expect(byId.get('node.root')).toMatchObject({ parentId: null, label: 'src', kind: 'Folder' });
    expect(byId.get('node.app')).toMatchObject({ parentId: 'node.root', label: 'app', kind: 'Folder' });
    expect(byId.get('node.page')).toMatchObject({ parentId: 'node.app', label: 'page.tsx', kind: 'File' });
    expect(byId.get('node.readme')).toMatchObject({ parentId: null, label: 'README.md', kind: 'File' });
  });

  // @spec EC-05
  it('excludes graph-internal kinds so only Folder and File nodes reach the payload', async () => {
    const { structureTreePayload } = await loadAdapters();
    const payload = structureTreePayload([...renderableNodes(), ...graphInternalNodes()]);

    expect(payload.nodes.map((node) => node.id).sort()).toEqual(['node.app', 'node.page', 'node.readme', 'node.root']);
    expect([...new Set(payload.nodes.map((node) => node.kind))].sort()).toEqual(['File', 'Folder']);
  });

  // @spec EC-05
  it('returns a valid empty tree payload for an empty graph', async () => {
    const { structureTreePayload } = await loadAdapters();
    const { isWorkspaceShapePayload } = await loadShapes();

    const payload = structureTreePayload([]);
    expect(payload).toEqual({ shape: 'tree', nodes: [] });
    expect(isWorkspaceShapePayload('tree', payload)).toBe(true);
  });

  // @spec EC-05
  it('emits a tree payload the frozen shape guard accepts', async () => {
    const { structureTreePayload } = await loadAdapters();
    const { isWorkspaceShapePayload } = await loadShapes();

    const payload = structureTreePayload([...renderableNodes(), ...graphInternalNodes()]);
    expect(isWorkspaceShapePayload('tree', payload)).toBe(true);
    expect(isWorkspaceShapePayload('collection', payload)).toBe(false);
  });

  // @spec AC-13
  it('projects features into a collection payload keyed by feature id', async () => {
    const { featuresCollectionPayload } = await loadAdapters();
    const { isWorkspaceShapePayload } = await loadShapes();

    const features = featureFixture();
    const payload = featuresCollectionPayload(features, nodePathFixture());

    expect(payload.shape).toBe('collection');
    expect(payload.items).toHaveLength(features.length);
    expect(payload.items.map((item) => item.id).sort()).toEqual(['feature.checkout', 'feature.search']);
    expect(payload.items.find((item) => item.id === 'feature.checkout')?.title).toBe('Checkout');
    expect(payload.items.find((item) => item.id === 'feature.search')?.title).toBe('Search');
    expect(isWorkspaceShapePayload('collection', payload)).toBe(true);
  });

  // @spec AC-13
  it('is pure: identical inputs give identical output and no input is mutated', async () => {
    const { featuresCollectionPayload, structureTreePayload } = await loadAdapters();

    const nodes = renderableNodes();
    const nodesBefore = structuredClone(nodes);
    const firstTree = structureTreePayload(nodes);
    const secondTree = structureTreePayload(nodes);
    expect(nodes).toEqual(nodesBefore);
    expect(secondTree).toEqual(firstTree);

    const features = featureFixture();
    const featuresBefore = structuredClone(features);
    const nodePaths = nodePathFixture();
    const nodePathsBefore = [...nodePaths.entries()];
    const firstCollection = featuresCollectionPayload(features, nodePaths);
    const secondCollection = featuresCollectionPayload(features, nodePaths);
    expect(features).toEqual(featuresBefore);
    expect([...nodePaths.entries()]).toEqual(nodePathsBefore);
    expect(secondCollection).toEqual(firstCollection);
  });

  // @spec AC-13
  it('keeps the adapter module free of hooks, fetching, and storage access', async () => {
    const path = resolve(repositoryRoot(), 'apps/web/app/workspace/packs/shapeAdapters.ts');
    expect(
      existsSync(path),
      'FE-ARCH-02 shape adapters are not implemented yet: apps/web/app/workspace/packs/shapeAdapters.ts',
    ).toBe(true);
    const source = readFileSync(path, 'utf8');

    for (const [pattern, label] of [
      [/\buse[A-Z]\w*\s*\(/, 'a React hook call'],
      [/\bfetch\s*\(/, 'network fetch'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/\bWebSocket\b/, 'WebSocket'],
      [/\blocalStorage\b/, 'localStorage'],
      [/\bsessionStorage\b/, 'sessionStorage'],
      [/'use client'/, 'a client-component directive'],
    ] as const) {
      expect(pattern.test(source), `shapeAdapters.ts contains ${label}`).toBe(false);
    }
    for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      expect(
        match[1] === 'react' || match[1].startsWith('react/'),
        `shapeAdapters.ts imports React: ${match[1]}`,
      ).toBe(false);
    }
  });
});

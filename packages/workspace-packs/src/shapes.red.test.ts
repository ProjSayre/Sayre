/**
 * FE-ARCH-02 red suite — the frozen v1 shape set and its payload guard.
 *
 * Authored from .pipeline/spec.md before `packages/workspace-packs/src/shapes.ts` exists. The module
 * under test is loaded through a guarded dynamic import — the convention this repository already uses
 * for leading-red suites (see apps/web/app/workspace/workspacePacks.red.test.ts) — so that a missing
 * implementation fails as a named assertion inside each test rather than as a whole-file module
 * resolution crash, and so this file type-checks before `dev` runs.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type ShapeId = 'collection' | 'tree' | 'graph' | 'document';

interface ShapesModule {
  WORKSPACE_SHAPES: readonly ShapeId[];
  isWorkspaceShapePayload(shape: ShapeId, value: unknown): boolean;
}

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'packages/workspace-packs/src/contracts.ts'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

async function loadShapes(): Promise<ShapesModule> {
  const path = resolve(repositoryRoot(), 'packages/workspace-packs/src/shapes.ts');
  expect(
    existsSync(path),
    'FE-ARCH-02 shape contract is not implemented yet: packages/workspace-packs/src/shapes.ts',
  ).toBe(true);
  return vi.importActual<ShapesModule>('./shapes');
}

/** One minimally-populated valid payload per frozen shape. */
const minimalPayloads: readonly (readonly [ShapeId, unknown])[] = [
  ['collection', { shape: 'collection', items: [] }],
  ['tree', { shape: 'tree', nodes: [] }],
  ['graph', { shape: 'graph', nodes: [], edges: [] }],
  ['document', { shape: 'document', title: 'Pitch', blocks: [] }],
];

/** The same four shapes carrying their optional and repeated members. */
const populatedPayloads: readonly (readonly [ShapeId, unknown])[] = [
  ['collection', {
    shape: 'collection',
    items: [
      { id: 'feature.checkout', title: 'Checkout', subtitle: 'Cart to receipt', group: 'payments' },
      { id: 'feature.search', title: 'Search', status: 'ready', timestamp: '2026-08-07T00:00:00.000Z', ref: { kind: 'feature', id: 'feature.search' } },
    ],
    groups: [{ id: 'payments', label: 'Payments' }],
  }],
  ['tree', {
    shape: 'tree',
    nodes: [
      { id: 'node.root', parentId: null, label: 'src', kind: 'Folder' },
      { id: 'node.page', parentId: 'node.root', label: 'page.tsx', kind: 'File' },
    ],
  }],
  ['graph', {
    shape: 'graph',
    nodes: [{ id: 'node.root', label: 'src', kind: 'Folder' }, { id: 'node.page', label: 'page.tsx', kind: 'File' }],
    edges: [{ source: 'node.root', target: 'node.page', type: 'CONTAINS' }],
  }],
  ['document', {
    shape: 'document',
    title: 'Pitch',
    blocks: [
      { kind: 'heading', text: 'Why now' },
      { kind: 'paragraph', text: 'Because the graph is the source of truth.' },
      { kind: 'list', text: 'Surfaces', items: ['explorer', 'inspector'] },
      { kind: 'code', text: 'MATCH (n) RETURN n' },
    ],
  }],
];

/** [asked shape, value, why it must be rejected]. */
const malformedPayloads: readonly (readonly [ShapeId, unknown, string])[] = [
  ['collection', null, 'null is not a payload'],
  ['tree', undefined, 'undefined is not a payload'],
  ['tree', 'tree', 'a string is not a payload'],
  ['graph', 42, 'a number is not a payload'],
  ['collection', [], 'an array is not a payload object'],
  ['collection', { shape: 'tree', nodes: [] }, 'discriminant disagrees with the asked collection shape'],
  ['tree', { shape: 'collection', items: [] }, 'discriminant disagrees with the asked tree shape'],
  ['document', { shape: 'graph', nodes: [], edges: [] }, 'discriminant disagrees with the asked document shape'],
  ['collection', { shape: 'collection', items: [{ title: 'No identifier' }] }, 'collection item without an id'],
  ['tree', { shape: 'tree', nodes: [{ parentId: null, label: 'src', kind: 'Folder' }] }, 'tree node without an id'],
  ['tree', { shape: 'tree', nodes: [{ id: 'node.root', parentId: null, kind: 'Folder' }] }, 'tree node without a label'],
  ['tree', { shape: 'tree', nodes: [{ id: 'node.root', parentId: 7, label: 'src', kind: 'Folder' }] }, 'tree node whose parentId is neither null nor a string'],
  ['graph', { shape: 'graph', nodes: [], edges: [{ target: 'node.page', type: 'CONTAINS' }] }, 'graph edge missing source'],
  ['graph', { shape: 'graph', nodes: [], edges: [{ source: 'node.root', type: 'CONTAINS' }] }, 'graph edge missing target'],
  ['document', { shape: 'document', title: 'Pitch', blocks: [{ kind: 'sidebar', text: 'Aside' }] }, 'document block of an unknown kind'],
];

describe('FE-ARCH-02 frozen workspace shapes', () => {
  // @spec AC-01
  it('freezes the v1 shape set to exactly collection, tree, graph, and document', async () => {
    const { WORKSPACE_SHAPES } = await loadShapes();
    expect([...WORKSPACE_SHAPES]).toEqual(['collection', 'tree', 'graph', 'document']);
  });

  // @spec EC-04
  it('accepts a minimal and a populated valid payload for each of the four shapes', async () => {
    const { isWorkspaceShapePayload } = await loadShapes();
    for (const [shape, payload] of minimalPayloads) {
      expect(isWorkspaceShapePayload(shape, payload), `minimal ${shape} payload must be accepted`).toBe(true);
    }
    for (const [shape, payload] of populatedPayloads) {
      expect(isWorkspaceShapePayload(shape, payload), `populated ${shape} payload must be accepted`).toBe(true);
    }
  });

  // @spec EC-04
  it('rejects malformed payloads and payloads whose discriminant disagrees with the asked shape', async () => {
    const { isWorkspaceShapePayload } = await loadShapes();
    for (const [shape, value, why] of malformedPayloads) {
      expect(isWorkspaceShapePayload(shape, value), `rejected for ${shape}: ${why}`).toBe(false);
    }
  });

  // @spec EC-04
  it('reports rather than throws for every malformed payload', async () => {
    const { isWorkspaceShapePayload } = await loadShapes();
    for (const [shape, value, why] of malformedPayloads) {
      expect(() => isWorkspaceShapePayload(shape, value), `must not throw for ${shape}: ${why}`).not.toThrow();
    }
  });
});

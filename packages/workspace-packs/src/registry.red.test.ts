/**
 * FE-ARCH-02 red suite — the manifest registry: shape-keyed pairing, binding validation, renderer
 * resolution with fallback, and the serializable snapshot.
 *
 * Authored from .pipeline/spec.md before `packages/workspace-packs/src/registry.ts` exists. The
 * module under test is loaded through a guarded dynamic import (same convention as
 * shapes.red.test.ts) so a missing implementation fails as a named assertion per test.
 *
 * The architecture claim under test is N + M registrations -> N x M valid combinations with no
 * pairwise wiring, so AC-02/AC-03 assert `pairings()` by value on a freshly created registry before
 * and after a single registration, never by count.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type ShapeId = 'collection' | 'tree' | 'graph' | 'document';
type SlotId = 'top' | 'navigation' | 'explorer' | 'primary' | 'inspector' | 'bottom' | 'overlay';
type Role = 'member' | 'admin' | 'owner';

interface Violation { code: string; path: string; message: string }
type RegistrationResult = { ok: true } | { ok: false; violations: readonly Violation[] };

interface DataCapabilityManifest {
  id: string; version: number; title: string;
  shape: ShapeId;
  requiredGates: readonly string[];
  minimumRole: Role | null;
}
interface RendererManifest {
  id: string; version: number; title: string;
  shape: ShapeId;
  allowedSlots: readonly SlotId[];
  isDefaultForShape?: boolean;
}
interface ComponentRef { id: string; version: number }
interface ModuleBinding { capability: ComponentRef; renderer: ComponentRef }
interface BindingContext { slot: SlotId; role: Role; grantedGates: ReadonlySet<string> }
type RendererResolution =
  | { renderer: RendererManifest; fallback: 'preferred' | 'shape-default' }
  | { renderer: null; fallback: 'none' };
interface RegistryContract {
  dataCapabilities: readonly DataCapabilityManifest[];
  renderers: readonly RendererManifest[];
}
interface Registry {
  registerDataCapability(manifest: DataCapabilityManifest): RegistrationResult;
  registerRenderer(manifest: RendererManifest): RegistrationResult;
  pairings(): readonly ModuleBinding[];
  validateBinding(binding: ModuleBinding, context: BindingContext): RegistrationResult;
  resolveRenderer(capability: ComponentRef, preferred: ComponentRef | null): RendererResolution;
  snapshot(): RegistryContract;
}
interface RegistryModule {
  createWorkspaceRegistry(reservedComponentIds?: ReadonlySet<string>): Registry;
}

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'packages/workspace-packs/src/contracts.ts'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

async function loadRegistry(): Promise<RegistryModule> {
  const path = resolve(repositoryRoot(), 'packages/workspace-packs/src/registry.ts');
  expect(
    existsSync(path),
    'FE-ARCH-02 manifest registry is not implemented yet: packages/workspace-packs/src/registry.ts',
  ).toBe(true);
  return vi.importActual<RegistryModule>('./registry');
}

function capability(id: string, shape: ShapeId, overrides: Partial<DataCapabilityManifest> = {}): DataCapabilityManifest {
  return { id, version: 1, title: id, shape, requiredGates: [], minimumRole: null, ...overrides };
}

function renderer(id: string, shape: ShapeId, overrides: Partial<RendererManifest> = {}): RendererManifest {
  return { id, version: 1, title: id, shape, allowedSlots: ['inspector'], ...overrides };
}

/** Every pairing as a stable "capability -> renderer" string, sorted, for value-level comparison. */
function pairKeys(registry: Registry): string[] {
  return registry
    .pairings()
    .map((binding) => `${binding.capability.id}@${binding.capability.version} -> ${binding.renderer.id}@${binding.renderer.version}`)
    .sort();
}

/** Asserts acceptance while surfacing the violations in the failure diff when it is rejected. */
function expectAccepted(result: RegistrationResult): void {
  expect(result.ok ? null : result.violations).toBeNull();
}

function violationsOf(result: RegistrationResult): readonly Violation[] {
  expect(result.ok, 'expected this manifest or binding to be rejected').toBe(false);
  return result.ok ? [] : result.violations;
}

function violationText(result: RegistrationResult): string {
  return JSON.stringify(violationsOf(result));
}

/** Every path in a JSON-ish value that holds a function (a React component included). */
function functionPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'function') return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => functionPaths(item, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => functionPaths(item, `${path}.${key}`));
  }
  return [];
}

describe('FE-ARCH-02 workspace manifest registry', () => {
  // @spec AC-01
  it('rejects any shape outside the frozen v1 set, naming the offending shape, without throwing', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    let capabilityResult!: RegistrationResult;
    let rendererResult!: RegistrationResult;
    expect(() => {
      capabilityResult = registry.registerDataCapability({ ...capability('sayre.tickets', 'collection'), shape: 'kanban' as unknown as ShapeId });
      rendererResult = registry.registerRenderer({ ...renderer('sayre.kanban-board', 'collection', { allowedSlots: ['primary'] }), shape: 'kanban' as unknown as ShapeId });
    }).not.toThrow();
    expect(violationText(capabilityResult)).toContain('kanban');
    expect(violationText(rendererResult)).toContain('kanban');
    expect(registry.snapshot()).toEqual({ dataCapabilities: [], renderers: [] });
    expect(pairKeys(registry)).toEqual([]);
  });

  // @spec AC-02
  it('pairs a newly registered capability with every already-registered renderer of its shape and no other', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true })));
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-outline', 'tree', { allowedSlots: ['navigation'] })));
    expectAccepted(registry.registerRenderer(renderer('sayre.pitch-summary-panel', 'collection', { allowedSlots: ['inspector'], isDefaultForShape: true })));
    expect(pairKeys(registry)).toEqual([]);

    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree')));

    expect(pairKeys(registry)).toEqual([
      'sayre.structure@1 -> sayre.tree-list@1',
      'sayre.structure@1 -> sayre.tree-outline@1',
    ]);
    expect(pairKeys(registry).some((key) => key.includes('pitch-summary-panel'))).toBe(false);
  });

  // @spec AC-03
  it('adds exactly one binding per existing same-shape capability when a renderer registers, leaving prior bindings unchanged', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer'], isDefaultForShape: true })));
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree')));
    expectAccepted(registry.registerDataCapability(capability('sayre.dependencies', 'tree')));
    expectAccepted(registry.registerDataCapability(capability('sayre.features', 'collection')));

    const before = pairKeys(registry);
    expect(before).toEqual([
      'sayre.dependencies@1 -> sayre.tree-list@1',
      'sayre.structure@1 -> sayre.tree-list@1',
    ]);

    expectAccepted(registry.registerRenderer(renderer('sayre.tree-outline', 'tree', { allowedSlots: ['navigation'] })));

    const after = pairKeys(registry);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after).toEqual([
      'sayre.dependencies@1 -> sayre.tree-list@1',
      'sayre.dependencies@1 -> sayre.tree-outline@1',
      'sayre.structure@1 -> sayre.tree-list@1',
      'sayre.structure@1 -> sayre.tree-outline@1',
    ]);
  });

  // @spec AC-04
  it('resolves a capability whose shape has no renderer to a defined none outcome with zero pairings', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer'], isDefaultForShape: true })));
    expectAccepted(registry.registerDataCapability(capability('sayre.release-notes', 'document')));

    expect(pairKeys(registry)).toEqual([]);

    let resolved!: RendererResolution;
    expect(() => {
      resolved = registry.resolveRenderer({ id: 'sayre.release-notes', version: 1 }, null);
    }).not.toThrow();
    expect(resolved).toEqual({ renderer: null, fallback: 'none' });

    let resolvedWithPreference!: RendererResolution;
    expect(() => {
      resolvedWithPreference = registry.resolveRenderer({ id: 'sayre.release-notes', version: 1 }, { id: 'sayre.tree-list', version: 1 });
    }).not.toThrow();
    expect(resolvedWithPreference).toEqual({ renderer: null, fallback: 'none' });
  });

  // @spec AC-05
  it('returns the preferred renderer when it is registered and the shape default when it is not', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true })));
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-outline', 'tree', { allowedSlots: ['navigation'] })));
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree')));
    const structure = { id: 'sayre.structure', version: 1 };

    expect(registry.resolveRenderer(structure, { id: 'sayre.tree-outline', version: 1 })).toMatchObject({
      fallback: 'preferred',
      renderer: { id: 'sayre.tree-outline', version: 1, shape: 'tree', allowedSlots: ['navigation'] },
    });
    expect(registry.resolveRenderer(structure, { id: 'sayre.tree-outline', version: 7 })).toMatchObject({
      fallback: 'shape-default',
      renderer: { id: 'sayre.tree-list', version: 1 },
    });
    expect(registry.resolveRenderer(structure, { id: 'sayre.absent-renderer', version: 1 })).toMatchObject({
      fallback: 'shape-default',
      renderer: { id: 'sayre.tree-list', version: 1 },
    });
    expect(registry.resolveRenderer(structure, null)).toMatchObject({
      fallback: 'shape-default',
      renderer: { id: 'sayre.tree-list', version: 1 },
    });
  });

  // @spec AC-05 AC-08
  it('falls back to the shape default when the preferred renderer belongs to another shape', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer'], isDefaultForShape: true })));
    expectAccepted(registry.registerRenderer(renderer('sayre.pitch-summary-panel', 'collection', { allowedSlots: ['inspector'], isDefaultForShape: true })));
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree')));

    expect(registry.resolveRenderer({ id: 'sayre.structure', version: 1 }, { id: 'sayre.pitch-summary-panel', version: 1 })).toMatchObject({
      fallback: 'shape-default',
      renderer: { id: 'sayre.tree-list', version: 1, shape: 'tree' },
    });
  });

  // @spec AC-06
  it('rejects a binding placed in a slot the renderer does not allow, identifying the slot', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree', { requiredGates: ['sayre.technical'] })));
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true })));
    const binding: ModuleBinding = { capability: { id: 'sayre.structure', version: 1 }, renderer: { id: 'sayre.tree-list', version: 1 } };
    const grantedGates = new Set(['sayre.technical']);

    const rejected = registry.validateBinding(binding, { slot: 'bottom', role: 'member', grantedGates });
    expect(violationText(rejected)).toContain('bottom');

    expectAccepted(registry.validateBinding(binding, { slot: 'explorer', role: 'member', grantedGates }));
    expectAccepted(registry.validateBinding(binding, { slot: 'navigation', role: 'member', grantedGates }));
  });

  // @spec AC-07
  it('rejects missing gates and roles below the capability minimum, and imposes no role constraint when minimumRole is null', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerDataCapability(capability('sayre.features', 'collection', { requiredGates: ['sayre.product'], minimumRole: 'admin' })));
    expectAccepted(registry.registerDataCapability(capability('sayre.open-features', 'collection', { requiredGates: [], minimumRole: null })));
    expectAccepted(registry.registerRenderer(renderer('sayre.pitch-summary-panel', 'collection', { allowedSlots: ['inspector'], isDefaultForShape: true })));
    const gated: ModuleBinding = { capability: { id: 'sayre.features', version: 1 }, renderer: { id: 'sayre.pitch-summary-panel', version: 1 } };
    const ungated: ModuleBinding = { capability: { id: 'sayre.open-features', version: 1 }, renderer: { id: 'sayre.pitch-summary-panel', version: 1 } };
    const granted = new Set(['sayre.product']);

    expectAccepted(registry.validateBinding(gated, { slot: 'inspector', role: 'owner', grantedGates: granted }));
    expectAccepted(registry.validateBinding(gated, { slot: 'inspector', role: 'admin', grantedGates: granted }));

    const belowRole = registry.validateBinding(gated, { slot: 'inspector', role: 'member', grantedGates: granted });
    expect(violationText(belowRole)).toMatch(/role/i);

    const missingGate = registry.validateBinding(gated, { slot: 'inspector', role: 'owner', grantedGates: new Set(['sayre.technical']) });
    expect(violationText(missingGate)).toMatch(/gate/i);

    expectAccepted(registry.validateBinding(ungated, { slot: 'inspector', role: 'member', grantedGates: new Set() }));
  });

  // @spec AC-08
  it('rejects a capability x renderer pair whose shapes differ even when the slot and gates pass', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree', { requiredGates: ['sayre.technical'] })));
    expectAccepted(registry.registerRenderer(renderer('sayre.pitch-summary-panel', 'collection', { allowedSlots: ['inspector'], isDefaultForShape: true })));

    const mismatched: ModuleBinding = { capability: { id: 'sayre.structure', version: 1 }, renderer: { id: 'sayre.pitch-summary-panel', version: 1 } };
    const rejected = registry.validateBinding(mismatched, { slot: 'inspector', role: 'owner', grantedGates: new Set(['sayre.technical']) });
    expect(violationText(rejected)).toMatch(/shape/i);
    expect(pairKeys(registry)).toEqual([]);
  });

  // @spec AC-09
  it('snapshots every successful registration as JSON-serializable data, excluding failed registrations', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree', { title: 'Repository structure', requiredGates: ['sayre.technical'] })));
    expectAccepted(registry.registerDataCapability(capability('sayre.features', 'collection', { title: 'Product features', requiredGates: ['sayre.product'] })));
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { title: 'Tree list', allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true })));
    expectAccepted(registry.registerRenderer(renderer('sayre.pitch-summary-panel', 'collection', { title: 'Pitch summary panel', allowedSlots: ['inspector'], isDefaultForShape: true })));
    violationsOf(registry.registerDataCapability({ ...capability('sayre.tickets', 'collection'), shape: 'kanban' as unknown as ShapeId }));
    violationsOf(registry.registerRenderer(renderer('sayre.nowhere-panel', 'collection', { allowedSlots: [] })));

    const snapshot = registry.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(functionPaths(snapshot)).toEqual([]);
    expect(snapshot.dataCapabilities.map((manifest) => `${manifest.id}@${manifest.version}`).sort()).toEqual([
      'sayre.features@1',
      'sayre.structure@1',
    ]);
    expect(snapshot.renderers.map((manifest) => `${manifest.id}@${manifest.version}`).sort()).toEqual([
      'sayre.pitch-summary-panel@1',
      'sayre.tree-list@1',
    ]);
    expect(snapshot.dataCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sayre.structure', version: 1, title: 'Repository structure', shape: 'tree', requiredGates: ['sayre.technical'] }),
    ]));
    expect(snapshot.renderers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sayre.tree-list', version: 1, shape: 'tree', allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true }),
    ]));
  });

  // @spec EC-01
  it('rejects a duplicate id@version and leaves the original manifest and every pairing unchanged', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree', { title: 'Repository structure' })));
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { title: 'Tree list', allowedSlots: ['explorer'], isDefaultForShape: true })));
    const before = pairKeys(registry);
    expect(before).toEqual(['sayre.structure@1 -> sayre.tree-list@1']);

    expect(violationsOf(registry.registerDataCapability(capability('sayre.structure', 'collection', { title: 'Impostor capability' }))).length).toBeGreaterThan(0);
    expect(violationsOf(registry.registerRenderer(renderer('sayre.tree-list', 'collection', { title: 'Impostor renderer', allowedSlots: ['inspector'] }))).length).toBeGreaterThan(0);

    expect(pairKeys(registry)).toEqual(before);
    const snapshot = registry.snapshot();
    expect(snapshot.dataCapabilities).toEqual([expect.objectContaining({ id: 'sayre.structure', version: 1, title: 'Repository structure', shape: 'tree' })]);
    expect(snapshot.renderers).toEqual([expect.objectContaining({ id: 'sayre.tree-list', version: 1, title: 'Tree list', shape: 'tree', allowedSlots: ['explorer'] })]);
  });

  // @spec EC-02
  it('treats id@2 as a manifest that coexists with id@1, pairing and resolving independently', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    expectAccepted(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer'], isDefaultForShape: true })));
    expectAccepted(registry.registerRenderer({ ...renderer('sayre.tree-list', 'tree', { allowedSlots: ['explorer', 'navigation'] }), version: 2 }));
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree')));

    expect(pairKeys(registry)).toEqual([
      'sayre.structure@1 -> sayre.tree-list@1',
      'sayre.structure@1 -> sayre.tree-list@2',
    ]);

    const structure = { id: 'sayre.structure', version: 1 };
    expect(registry.resolveRenderer(structure, { id: 'sayre.tree-list', version: 2 })).toMatchObject({
      fallback: 'preferred',
      renderer: { id: 'sayre.tree-list', version: 2, allowedSlots: ['explorer', 'navigation'] },
    });
    expect(registry.resolveRenderer(structure, { id: 'sayre.tree-list', version: 1 })).toMatchObject({
      fallback: 'preferred',
      renderer: { id: 'sayre.tree-list', version: 1, allowedSlots: ['explorer'] },
    });
    expect(registry.resolveRenderer(structure, { id: 'sayre.tree-list', version: 3 })).toMatchObject({
      fallback: 'shape-default',
      renderer: { id: 'sayre.tree-list', version: 1 },
    });
  });

  // @spec EC-03
  it('rejects a renderer that declares no allowed slots and leaves the registry unchanged', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry();
    const rejected = registry.registerRenderer(renderer('sayre.nowhere-panel', 'tree', { allowedSlots: [] }));
    expect(violationText(rejected)).toMatch(/slot/i);

    expect(registry.snapshot().renderers).toEqual([]);
    expectAccepted(registry.registerDataCapability(capability('sayre.structure', 'tree')));
    expect(pairKeys(registry)).toEqual([]);
  });

  // @spec EC-06
  it('rejects manifests colliding with a reserved legacy component id, keeping the alias namespace unambiguous', async () => {
    const { createWorkspaceRegistry } = await loadRegistry();
    const registry = createWorkspaceRegistry(new Set(['sayre.explorer@1', 'sayre.pitch-summary@1']));

    expect(violationsOf(registry.registerDataCapability(capability('sayre.explorer', 'tree'))).length).toBeGreaterThan(0);
    expect(violationsOf(registry.registerRenderer(renderer('sayre.pitch-summary', 'collection', { allowedSlots: ['inspector'] }))).length).toBeGreaterThan(0);
    expect(registry.snapshot()).toEqual({ dataCapabilities: [], renderers: [] });

    // The reservation is id@version-scoped, exactly as EC-06 states it ("whose id@version collides").
    expectAccepted(registry.registerRenderer({ ...renderer('sayre.explorer', 'tree', { allowedSlots: ['explorer'] }), version: 2 }));
    expect(registry.snapshot().renderers.map((manifest) => `${manifest.id}@${manifest.version}`)).toEqual(['sayre.explorer@2']);
  });
});

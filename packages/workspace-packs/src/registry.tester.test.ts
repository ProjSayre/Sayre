/**
 * FE-ARCH-02 tester-added coverage — non-behavioral stress/property exercises of the manifest
 * registry's already-fixed contracts. Every assertion here re-runs a rule registry.red.test.ts
 * already pinned (the N-capabilities x M-renderers pairing law of AC-02/AC-03, snapshot's
 * repeatability, JSON-serializable round-tripping of AC-09) at a larger scale or with harder field
 * content — it does not decide any new interpretation of what the registry should do. Per
 * .sdd/stages/tester.md this file adds only non-behavioral coverage.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspaceRegistry, type WorkspaceDataCapabilityManifest, type WorkspaceRendererManifest } from './registry';
import { WORKSPACE_SHAPES, type WorkspaceShapeId } from './shapes';

function capability(id: string, shape: WorkspaceShapeId, overrides: Partial<WorkspaceDataCapabilityManifest> = {}): WorkspaceDataCapabilityManifest {
  return { id, version: 1, title: id, shape, requiredGates: [], minimumRole: null, ...overrides };
}

function renderer(id: string, shape: WorkspaceShapeId, overrides: Partial<WorkspaceRendererManifest> = {}): WorkspaceRendererManifest {
  return { id, version: 1, title: id, shape, allowedSlots: ['inspector'], ...overrides };
}

describe('FE-ARCH-02 tester coverage — manifest registry under stress', () => {
  // The same N x M pairing law AC-02/AC-03 already fix at a handful of registrations, exercised at
  // a scale no red case tries: per frozen shape, N capabilities and M renderers must yield exactly
  // N x M bindings, and zero bindings must cross a shape boundary.
  it('holds the N x M pairing law exactly at a larger scale, per shape and with no cross-shape leakage', () => {
    const registry = createWorkspaceRegistry();
    const perShapeCount = 15;
    for (const shape of WORKSPACE_SHAPES) {
      for (let i = 0; i < perShapeCount; i += 1) {
        expect(registry.registerDataCapability(capability(`cap.${shape}.${i}`, shape)).ok).toBe(true);
        expect(registry.registerRenderer(renderer(`ren.${shape}.${i}`, shape)).ok).toBe(true);
      }
    }

    const pairings = registry.pairings();
    expect(pairings).toHaveLength(WORKSPACE_SHAPES.length * perShapeCount * perShapeCount);

    for (const shape of WORKSPACE_SHAPES) {
      const withinShape = pairings.filter((binding) => binding.capability.id.startsWith(`cap.${shape}.`));
      expect(withinShape).toHaveLength(perShapeCount * perShapeCount);
      // No pairing may cross into a renderer registered for a different shape.
      expect(withinShape.every((binding) => binding.renderer.id.startsWith(`ren.${shape}.`))).toBe(true);
    }

    // Spot-check a specific pairing exists by value, the same style AC-02/AC-03 use, just at scale.
    expect(pairings).toContainEqual({
      capability: { id: 'cap.tree.7', version: 1 },
      renderer: { id: 'ren.tree.3', version: 1 },
    });
  });

  // Idempotence of snapshot(): repeated calls with no intervening registration return deep-equal
  // results every time, and a snapshot taken after further registrations is a strict superset by
  // value of every entry the prior snapshot already reported (AC-09's "lists every successfully
  // registered manifest" claim, re-checked across repeated/interleaved calls rather than once).
  it('is idempotent: repeated snapshot() calls agree, and later snapshots are supersets of earlier ones', () => {
    const registry = createWorkspaceRegistry();
    expect(registry.registerDataCapability(capability('sayre.structure', 'tree')).ok).toBe(true);
    expect(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { isDefaultForShape: true })).ok).toBe(true);

    const first = registry.snapshot();
    const second = registry.snapshot();
    const third = registry.snapshot();
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    expect(registry.registerDataCapability(capability('sayre.features', 'collection')).ok).toBe(true);
    const afterMoreRegistrations = registry.snapshot();
    expect(afterMoreRegistrations.dataCapabilities).toEqual(expect.arrayContaining([...first.dataCapabilities]));
    expect(afterMoreRegistrations.renderers).toEqual(expect.arrayContaining([...first.renderers]));
    expect(afterMoreRegistrations.dataCapabilities.length).toBeGreaterThan(first.dataCapabilities.length);
  });

  // AC-09's JSON round-trip and no-function-values claims, re-checked with unicode and very long
  // string field content instead of short ASCII fixtures, plus a larger requiredGates/allowedSlots
  // array than any red case tries — the same fixed round-trip contract, harder data.
  it('preserves unicode and very long manifest field content exactly through registration and snapshot', () => {
    const registry = createWorkspaceRegistry();
    const longTitle = 'T'.repeat(10_000);
    const unicodeTitle = '仕様書 — spécification 🚀 مواصفة';
    const manyGates = Array.from({ length: 200 }, (_, index) => `sayre.gate-${index}`);
    const manySlots = ['top', 'navigation', 'explorer', 'primary', 'inspector', 'bottom', 'overlay'] as const;

    expect(registry.registerDataCapability(
      capability('sayre.unicode-capability', 'tree', { title: unicodeTitle, requiredGates: manyGates }),
    ).ok).toBe(true);
    expect(registry.registerRenderer(
      renderer('sayre.unicode-renderer', 'tree', { title: longTitle, allowedSlots: manySlots, isDefaultForShape: true }),
    ).ok).toBe(true);

    const snapshot = registry.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    const cap = snapshot.dataCapabilities.find((manifest) => manifest.id === 'sayre.unicode-capability');
    const ren = snapshot.renderers.find((manifest) => manifest.id === 'sayre.unicode-renderer');
    expect(cap?.title).toBe(unicodeTitle);
    expect(cap?.requiredGates).toEqual(manyGates);
    expect(ren?.title).toBe(longTitle);
    expect(ren?.allowedSlots).toEqual(manySlots);
  });

  // validateBinding / resolveRenderer must not throw across a battery of well-typed but unusual
  // component refs (never-registered id, negative/zero/huge version numbers, empty-string id) — the
  // same already-fixed "never throws" property AC-04/AC-05/AC-06/AC-07 establish, exercised against
  // refs no red case happens to try.
  it('never throws for validateBinding or resolveRenderer given unusual but well-typed component refs', () => {
    const registry = createWorkspaceRegistry();
    expect(registry.registerDataCapability(capability('sayre.structure', 'tree')).ok).toBe(true);
    expect(registry.registerRenderer(renderer('sayre.tree-list', 'tree', { isDefaultForShape: true })).ok).toBe(true);

    const unusualRefs = [
      { id: '', version: 1 },
      { id: 'sayre.never-registered', version: 1 },
      { id: 'sayre.structure', version: -1 },
      { id: 'sayre.structure', version: 0 },
      { id: 'sayre.structure', version: Number.MAX_SAFE_INTEGER },
      { id: '仕様書', version: 1 },
    ];

    for (const capabilityRef of unusualRefs) {
      for (const rendererRef of unusualRefs) {
        expect(() => registry.validateBinding(
          { capability: capabilityRef, renderer: rendererRef },
          { slot: 'inspector', role: 'owner', grantedGates: new Set() },
        )).not.toThrow();
      }
      for (const preferredRef of [...unusualRefs, null]) {
        expect(() => registry.resolveRenderer(capabilityRef, preferredRef)).not.toThrow();
      }
    }
  });
});

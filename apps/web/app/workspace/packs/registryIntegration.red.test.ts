/**
 * FE-ARCH-02 red suite — the app's built-in registrations, the legacy alias layer derived from them,
 * and the additive runtime contract.
 *
 * Authored from .pipeline/spec.md before the registry exists. Back-compat is exercised through the
 * real activation path — importing `./builtins` already runs parse -> compatibility -> component-prop
 * validation for both built-in packs and throws on any failure — rather than by snapshotting
 * internals. The pre-existing suites remain the broader back-compat oracle; the assertions here add
 * the coupling between an activated pack's component refs and the registry manifests they are now
 * derived from.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspaceExperience,
  validateWorkspacePackCompatibility,
  type WorkspaceComponentCatalogContract,
} from '../../../../../packages/workspace-packs/src/runtime';
import { builtinWorkspacePacks, defaultWorkspacePack, pitchWorkspacePack } from './builtins';
import {
  workspaceComponentCatalog as reactComponentCatalog,
  type WorkspaceComponentRuntimeState,
} from './componentCatalog';
import { validateRuntimeComponentProps, workspaceComponentCatalog as runtimeContract } from './runtimeCatalog';

type ShapeId = 'collection' | 'tree' | 'graph' | 'document';
type SlotId = 'top' | 'navigation' | 'explorer' | 'primary' | 'inspector' | 'bottom' | 'overlay';
type Role = 'member' | 'admin' | 'owner';

interface DataCapabilityManifest {
  id: string; version: number; title: string;
  shape: ShapeId; requiredGates: readonly string[]; minimumRole: Role | null;
}
interface RendererManifest {
  id: string; version: number; title: string;
  shape: ShapeId; allowedSlots: readonly SlotId[]; isDefaultForShape?: boolean;
}
interface RegistrySnapshot {
  dataCapabilities: readonly DataCapabilityManifest[];
  renderers: readonly RendererManifest[];
}
interface RendererDefinition extends RendererManifest { Component: unknown }

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'apps/web/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

/** The registry snapshot the runtime catalog contract must now additionally carry (AC-12). */
function registrySnapshot(): RegistrySnapshot {
  const contract = runtimeContract as WorkspaceComponentCatalogContract & { registry?: RegistrySnapshot };
  expect(
    contract.registry,
    'FE-ARCH-02: the runtime catalog contract does not expose a registry snapshot yet',
  ).toBeDefined();
  return contract.registry as RegistrySnapshot;
}

function capabilityManifest(id: string, version: number): DataCapabilityManifest | undefined {
  return registrySnapshot().dataCapabilities.find((manifest) => manifest.id === id && manifest.version === version);
}

function rendererManifest(id: string, version: number): RendererManifest | undefined {
  return registrySnapshot().renderers.find((manifest) => manifest.id === id && manifest.version === version);
}

function isRendererDefinition(value: unknown): value is RendererDefinition {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.version === 'number'
    && Array.isArray(candidate.allowedSlots)
    && typeof candidate.Component === 'function';
}

/**
 * Renderer definitions found anywhere in the module's exports — array, Map, or single export — so
 * this suite pins the registered renderers rather than a container name spec.md leaves open.
 */
async function loadRendererDefinitions(): Promise<RendererDefinition[]> {
  const path = resolve(repositoryRoot(), 'apps/web/app/workspace/packs/rendererCatalog.tsx');
  expect(
    existsSync(path),
    'FE-ARCH-02 renderer catalog is not implemented yet: apps/web/app/workspace/packs/rendererCatalog.tsx',
  ).toBe(true);
  const rendererModule = await vi.importActual<Record<string, unknown>>('./rendererCatalog');
  const found: RendererDefinition[] = [];
  for (const value of Object.values(rendererModule)) {
    const candidates = value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [value];
    for (const candidate of candidates) if (isRendererDefinition(candidate)) found.push(candidate);
  }
  return found;
}

const runtimeState: WorkspaceComponentRuntimeState = {
  viewId: 'technical',
  fileTreeOpen: true,
  inspectorOpen: true,
  settingsOpen: false,
  selectedNodeId: 'node.page',
  selectedFeatureId: null,
};

describe('FE-ARCH-02 built-in registry registrations and legacy alias layer', () => {
  // @spec AC-10
  it('registers exactly the two v1 data capabilities and two v1 renderers', async () => {
    const snapshot = registrySnapshot();

    expect(snapshot.dataCapabilities
      .map((manifest) => ({ id: manifest.id, version: manifest.version, shape: manifest.shape, requiredGates: [...manifest.requiredGates] }))
      .sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'sayre.features', version: 1, shape: 'collection', requiredGates: ['sayre.product'] },
      { id: 'sayre.structure', version: 1, shape: 'tree', requiredGates: ['sayre.technical'] },
    ]);

    expect(snapshot.renderers
      .map((manifest) => ({
        id: manifest.id,
        version: manifest.version,
        shape: manifest.shape,
        allowedSlots: [...manifest.allowedSlots],
        isDefaultForShape: manifest.isDefaultForShape === true,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'sayre.pitch-summary-panel', version: 1, shape: 'collection', allowedSlots: ['inspector'], isDefaultForShape: true },
      { id: 'sayre.tree-list', version: 1, shape: 'tree', allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true },
    ]);
  });

  // @spec AC-10
  it('backs both registered renderers with a component in the renderer catalog', async () => {
    const definitions = await loadRendererDefinitions();
    const byKey = new Map(definitions.map((definition) => [`${definition.id}@${definition.version}`, definition]));

    expect([...byKey.keys()].sort()).toEqual(['sayre.pitch-summary-panel@1', 'sayre.tree-list@1']);
    expect(byKey.get('sayre.tree-list@1')).toMatchObject({ shape: 'tree', allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true });
    expect(byKey.get('sayre.pitch-summary-panel@1')).toMatchObject({ shape: 'collection', allowedSlots: ['inspector'], isDefaultForShape: true });
    expect(typeof byKey.get('sayre.tree-list@1')?.Component).toBe('function');
    expect(typeof byKey.get('sayre.pitch-summary-panel@1')?.Component).toBe('function');
  });

  // @spec AC-11 AC-12
  it('keeps the legacy explorer and pitch-summary aliases, derived from their registry bindings', async () => {
    const explorer = reactComponentCatalog.components.get('sayre.explorer@1');
    const pitchSummary = reactComponentCatalog.components.get('sayre.pitch-summary@1');

    // Unchanged legacy surface first: the pre-existing behavior this derivation may not disturb.
    expect(explorer).toBeDefined();
    expect(pitchSummary).toBeDefined();
    expect(explorer?.minimumRole).toBe('member');
    expect(pitchSummary?.minimumRole).toBe('member');
    expect(typeof explorer?.parseProps).toBe('function');
    expect(typeof pitchSummary?.parseProps).toBe('function');
    expect(explorer?.Component).toEqual(expect.any(Function));
    expect(pitchSummary?.Component).toEqual(expect.any(Function));
    expect(explorer?.landmarkLabel).toBe('Repository explorer');
    expect(pitchSummary?.landmarkLabel).toBe('Pitch summary');
    expect(explorer?.isPresent?.({ ...runtimeState, fileTreeOpen: true })).toBe(true);
    expect(explorer?.isPresent?.({ ...runtimeState, fileTreeOpen: false })).toBe(false);
    expect(runtimeContract.components.map((component) => `${component.id}@${component.version}`).sort()).toEqual([
      'sayre.explorer@1',
      'sayre.inspector@1',
      'sayre.pitch-summary@1',
      'sayre.primary-surface@1',
    ]);

    // Derived, not hand-written: each alias mirrors its capability x renderer binding.
    const structure = capabilityManifest('sayre.structure', 1);
    const treeList = rendererManifest('sayre.tree-list', 1);
    const features = capabilityManifest('sayre.features', 1);
    const panel = rendererManifest('sayre.pitch-summary-panel', 1);

    expect(explorer?.allowedSlots).toEqual(treeList?.allowedSlots);
    expect(explorer?.requiredCapabilities).toEqual(structure?.requiredGates);
    expect(pitchSummary?.allowedSlots).toEqual(panel?.allowedSlots);
    expect(pitchSummary?.requiredCapabilities).toEqual(features?.requiredGates);
    expect(structure?.shape).toBe(treeList?.shape);
    expect(features?.shape).toBe(panel?.shape);
  });

  // @spec AC-11
  it('parses, validates, and activates both built-in packs exactly as before', async () => {
    // Importing ./builtins already ran parse + compatibility + component-prop validation and would
    // have thrown; re-running the same path here keeps the assertion explicit.
    expect(builtinWorkspacePacks.map((installed) => installed.ref.id)).toEqual(['sayre.default', 'sayre.pitch']);
    for (const installed of builtinWorkspacePacks) {
      const compatible = validateWorkspacePackCompatibility(installed.pack, runtimeContract);
      expect(compatible.ok ? null : compatible.violations).toBeNull();
      const props = validateRuntimeComponentProps(installed.pack);
      expect(props.ok ? null : props.violations).toBeNull();
    }

    const experience = resolveWorkspaceExperience({
      safetyDefaults: defaultWorkspacePack.pack,
      selectedPack: pitchWorkspacePack.pack,
      organizationOverride: null,
      userOverride: null,
      userPreferences: null,
      catalog: runtimeContract,
      viewportClass: 'wide',
      role: 'member',
    });
    expect(experience.usedSafetyFallback).toBe(false);
    expect(experience.warnings).toEqual([]);
    expect(experience.pack).toEqual(pitchWorkspacePack.ref);
    const inspector = experience.layout.regions.find((region) => region.slot === 'inspector');
    const explorerRegion = experience.layout.regions.find((region) => region.slot === 'explorer');
    expect(inspector?.component).toEqual({ id: 'sayre.pitch-summary', version: 1 });
    expect(explorerRegion?.component).toEqual({ id: 'sayre.explorer', version: 1 });

    // The slots the activated pack lands on are the slots the bound renderers actually allow.
    expect(rendererManifest('sayre.pitch-summary-panel', 1)?.allowedSlots).toContain('inspector');
    expect(rendererManifest('sayre.tree-list', 1)?.allowedSlots).toContain('explorer');
  });

  // @spec AC-12
  it('keeps the runtime contract at version 1 while additively exposing a serializable snapshot', async () => {
    expect(runtimeContract.runtimeContractVersion).toBe(1);
    expect(reactComponentCatalog.runtimeContractVersion).toBe(1);
    expect(reactComponentCatalog.contract.runtimeContractVersion).toBe(1);
    // Permission gates keep their identity; data capabilities are a separate concept.
    expect(runtimeContract.capabilities.map((capability) => capability.id)).toEqual([
      'sayre.technical',
      'sayre.product',
      'sayre.onboarding',
    ]);

    // A pack authored with no knowledge of the registry validates exactly as before.
    const registryNaivePack = structuredClone(defaultWorkspacePack.pack);
    const compatible = validateWorkspacePackCompatibility(registryNaivePack, runtimeContract);
    expect(compatible.ok ? null : compatible.violations).toBeNull();
    expect(validateRuntimeComponentProps(registryNaivePack).ok).toBe(true);

    const snapshot = registrySnapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(Object.keys(snapshot).sort()).toEqual(['dataCapabilities', 'renderers']);
  });
});

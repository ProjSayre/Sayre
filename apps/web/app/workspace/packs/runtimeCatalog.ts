import {
  createWorkspaceRegistry,
  type WorkspaceComponentCatalogContract,
  type WorkspacePackDocument,
  type WorkspacePackValidationResult,
  type WorkspaceRegistryContract,
} from '../../../../../packages/workspace-packs/src/runtime';
import { workspaceCapabilities, workspaceDataCapabilities } from './capabilityCatalog';
import { workspaceRendererDefinitions } from './rendererCatalog';

/** id@version of every entry in the hand-wired legacy catalog below — the registry's alias namespace. */
const LEGACY_COMPONENT_KEYS = Object.freeze([
  'sayre.primary-surface@1',
  'sayre.explorer@1',
  'sayre.inspector@1',
  'sayre.pitch-summary@1',
]);

function buildWorkspaceRegistrySnapshot(): WorkspaceRegistryContract {
  const registry = createWorkspaceRegistry(new Set(LEGACY_COMPONENT_KEYS));
  for (const manifest of workspaceDataCapabilities) {
    const result = registry.registerDataCapability(manifest);
    if (!result.ok) throw new Error(`Invalid built-in data capability "${manifest.id}@${manifest.version}": ${result.violations.map((item) => `${item.path} ${item.message}`).join('; ')}`);
  }
  for (const { Component: _Component, ...manifest } of workspaceRendererDefinitions) {
    const result = registry.registerRenderer(manifest);
    if (!result.ok) throw new Error(`Invalid built-in renderer "${manifest.id}@${manifest.version}": ${result.violations.map((item) => `${item.path} ${item.message}`).join('; ')}`);
  }
  return registry.snapshot();
}

/** Additive groundwork for the later LLM-authoring wave (AC-12); the app's two v1 bindings (AC-10). */
export const workspaceRegistrySnapshot: WorkspaceRegistryContract = buildWorkspaceRegistrySnapshot();

function requireManifest<T extends { id: string; version: number }>(items: readonly T[], id: string, version: number): T {
  const found = items.find((item) => item.id === id && item.version === version);
  if (found === undefined) throw new Error(`Workspace registry is missing "${id}@${version}".`);
  return found;
}

const structureCapability = requireManifest(workspaceRegistrySnapshot.dataCapabilities, 'sayre.structure', 1);
const treeListRenderer = requireManifest(workspaceRegistrySnapshot.renderers, 'sayre.tree-list', 1);
const featuresCapability = requireManifest(workspaceRegistrySnapshot.dataCapabilities, 'sayre.features', 1);
const pitchSummaryPanelRenderer = requireManifest(workspaceRegistrySnapshot.renderers, 'sayre.pitch-summary-panel', 1);

export interface WorkspaceRuntimeCatalogContract extends WorkspaceComponentCatalogContract {
  registry: WorkspaceRegistryContract;
}

export const workspaceComponentCatalog: WorkspaceRuntimeCatalogContract = Object.freeze({
  runtimeContractVersion: 1,
  capabilities: workspaceCapabilities,
  components: [
    {
      id: 'sayre.primary-surface',
      version: 1,
      allowedSlots: ['primary'],
      requiredCapabilities: [],
      minimumRole: 'member',
    },
    {
      id: 'sayre.explorer',
      version: 1,
      // Derived from the structure x tree-list registry binding (FE-ARCH-02), not hand-wired.
      allowedSlots: treeListRenderer.allowedSlots,
      requiredCapabilities: structureCapability.requiredGates,
      minimumRole: 'member',
    },
    {
      id: 'sayre.inspector',
      version: 1,
      allowedSlots: ['inspector'],
      requiredCapabilities: [],
      minimumRole: 'member',
    },
    {
      id: 'sayre.pitch-summary',
      version: 1,
      // Derived from the features x pitch-summary-panel registry binding (FE-ARCH-02), not hand-wired.
      allowedSlots: pitchSummaryPanelRenderer.allowedSlots,
      requiredCapabilities: featuresCapability.requiredGates,
      minimumRole: 'member',
    },
  ],
  registry: workspaceRegistrySnapshot,
} satisfies WorkspaceRuntimeCatalogContract);

const acceptedPropFields: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'sayre.primary-surface@1': [],
  'sayre.explorer@1': [],
  'sayre.inspector@1': [],
  'sayre.pitch-summary@1': [],
});

export function validateRuntimeComponentProps(pack: WorkspacePackDocument): WorkspacePackValidationResult {
  const refs = [
    ...pack.compatibility.requiredComponents.map((component) => ({ component, path: '/compatibility/requiredComponents' })),
    ...pack.layouts.flatMap((layout, layoutIndex) => layout.regions.map((region, regionIndex) => ({ component: region.component, path: `/layouts/${layoutIndex}/regions/${regionIndex}/component` }))),
    ...pack.views.flatMap((view, viewIndex) => [
      { component: view.surface, path: `/views/${viewIndex}/surface` },
      ...view.toolbar.map((component, index) => ({ component, path: `/views/${viewIndex}/toolbar/${index}` })),
      ...view.inspectorModules.map((component, index) => ({ component, path: `/views/${viewIndex}/inspectorModules/${index}` })),
    ]),
  ];
  const violations = refs.flatMap(({ component, path }) => {
    const allowed = acceptedPropFields[`${component.id}@${component.version}`];
    if (allowed === undefined) return [];
    const unknown = Object.keys(component.props ?? {}).filter((field) => !allowed.includes(field));
    return unknown.map((field) => ({ code: 'unknown-component-prop', path: `${path}/props/${field}`, message: 'Component property is not accepted by the trusted catalog.' }));
  });
  const trustedSettings = new Set(['workspace-packs', 'github', 'providers', 'mcp']);
  pack.settingsOrder.forEach((id, index) => {
    if (!trustedSettings.has(id)) violations.push({ code: 'unknown-setting', path: `/settingsOrder/${index}`, message: 'Settings entry is not present in the trusted registry.' });
  });
  return violations.length > 0 ? { ok: false, violations } : { ok: true, pack, warnings: [] };
}

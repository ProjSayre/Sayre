import type { WorkspaceDataCapabilityManifest } from '../../../../../packages/workspace-packs/src/runtime';
import type { WorkspaceDataSource, WorkspaceScope } from '../dataSource';
import type { WorkspaceGraph } from '../types';
import { workspaceView } from '../viewRegistry';

export interface WorkspaceCapabilityDefinition {
  id: string;
  version: number;
  load(source: WorkspaceDataSource, scope: WorkspaceScope, signal: AbortSignal): Promise<WorkspaceGraph>;
}

export const workspaceCapabilities = Object.freeze([
  { id: 'sayre.technical', version: 1 },
  { id: 'sayre.product', version: 1 },
  { id: 'sayre.onboarding', version: 1 },
]);

export const workspaceCapabilityCatalog: ReadonlyMap<string, WorkspaceCapabilityDefinition> = new Map([
  ['sayre.technical', { id: 'sayre.technical', version: 1, load: workspaceView('technical').load }],
  ['sayre.product', { id: 'sayre.product', version: 1, load: workspaceView('product').load }],
  ['sayre.onboarding', { id: 'sayre.onboarding', version: 1, load: workspaceView('onboarding').load }],
]);

/**
 * Data capabilities (server-authorized query surfaces) feeding the shape/renderer registry.
 * Distinct from the permission-gate list above: gates are referenced via `requiredGates`, never merged.
 */
export const workspaceDataCapabilities: readonly WorkspaceDataCapabilityManifest[] = Object.freeze([
  { id: 'sayre.structure', version: 1, title: 'Repository structure', shape: 'tree', requiredGates: ['sayre.technical'], minimumRole: null },
  { id: 'sayre.features', version: 1, title: 'Product features', shape: 'collection', requiredGates: ['sayre.product'], minimumRole: null },
]);

import type { WorkspaceDataSource, WorkspaceScope } from './dataSource';
import type { ViewId, WorkspaceGraph } from './types';

export interface WorkspaceViewDefinition {
  id: ViewId;
  glyph: string;
  label: string;
  hint: string;
  enabled: boolean;
  semantic: boolean;
  load(
    source: WorkspaceDataSource,
    scope: WorkspaceScope,
    signal: AbortSignal,
  ): Promise<WorkspaceGraph>;
}

const definitions: WorkspaceViewDefinition[] = [
  {
    id: 'technical',
    glyph: 'T',
    label: 'Technical',
    hint: 'Technical Tree — folders, files, imports',
    enabled: true,
    semantic: false,
    async load(source, scope, signal) {
      const graph = await source.technicalTree(scope, signal);
      return { ...graph, features: [], onboarding: null };
    },
  },
  {
    id: 'product',
    glyph: 'P',
    label: 'Product',
    hint: 'Product Tree — feature boundaries across files',
    enabled: true,
    semantic: true,
    async load(source, scope, signal) {
      const graph = await source.productTree(scope, signal);
      return { ...graph, onboarding: null };
    },
  },
  {
    id: 'onboarding',
    glyph: 'O',
    label: 'Onboarding',
    hint: 'Onboarding Tree — ordered, sandboxed setup',
    enabled: true,
    semantic: false,
    async load(source, scope, signal) {
      const graph = await source.onboardingTree(scope, signal);
      return { ...graph, features: [] };
    },
  },
];

/**
 * The registry is the only place a top-level view is declared. A post-MVP view
 * builder can produce the same definition shape instead of adding conditionals
 * throughout the shell.
 */
export const workspaceViews = Object.freeze(definitions);

export function workspaceView(id: ViewId): WorkspaceViewDefinition {
  const view = workspaceViews.find((candidate) => candidate.id === id);
  if (view === undefined) throw new Error(`Unknown workspace view: ${id}`);
  return view;
}

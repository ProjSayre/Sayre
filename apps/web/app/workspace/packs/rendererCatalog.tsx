import type { ComponentType } from 'react';
import type {
  ResolvedWorkspaceRegion,
  ResolvedWorkspaceView,
  WorkspaceRendererManifest,
  WorkspaceShapePayload,
} from '../../../../../packages/workspace-packs/src/runtime';
import { PitchSummaryPanel } from '../views/PitchSummaryPanel';

export interface WorkspaceRendererProps {
  payload: WorkspaceShapePayload;
  region: ResolvedWorkspaceRegion;
  view: ResolvedWorkspaceView;
}

export interface WorkspaceRendererDefinition extends WorkspaceRendererManifest {
  Component: ComponentType<WorkspaceRendererProps>;
}

/**
 * The registry-driven counterpart to `ExplorerContribution`: it draws the same Folder/File
 * hierarchy, but from a `TreePayload` alone rather than the live search/selection/expansion state
 * `FileTreePane` also carries — a shape payload is read-only projected data, not interactive state.
 */
function TreeListRenderer({ payload }: WorkspaceRendererProps) {
  const nodes = payload.shape === 'tree' ? payload.nodes : [];
  return (
    <ul aria-label="Repository structure" className="mock-filetree-rows">
      {nodes.map((node) => (
        <li key={node.id}>{node.label}</li>
      ))}
    </ul>
  );
}

/** Wraps the existing `PitchSummaryPanel` presentation, fed by a `CollectionPayload`. */
function PitchSummaryPanelRenderer({ payload }: WorkspaceRendererProps) {
  const items = payload.shape === 'collection' ? payload.items : [];
  return (
    <PitchSummaryPanel
      summary={{
        features: items.map((item) => ({
          id: item.id,
          name: item.title,
          description: item.subtitle ?? null,
          team: item.group ?? null,
          files: [],
          recentChanges: [],
        })),
      }}
    />
  );
}

export const workspaceRendererDefinitions: readonly WorkspaceRendererDefinition[] = [
  {
    id: 'sayre.tree-list', version: 1, title: 'Tree list', shape: 'tree',
    allowedSlots: ['explorer', 'navigation'], isDefaultForShape: true,
    Component: TreeListRenderer,
  },
  {
    id: 'sayre.pitch-summary-panel', version: 1, title: 'Pitch summary panel', shape: 'collection',
    allowedSlots: ['inspector'], isDefaultForShape: true,
    Component: PitchSummaryPanelRenderer,
  },
];

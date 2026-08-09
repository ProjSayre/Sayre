'use client';

import type { ComponentType } from 'react';
import type {
  JsonObject,
  WorkspaceComponentCatalogContract,
  WorkspaceComponentContract,
  WorkspaceComponentRef,
  ResolvedWorkspaceRegion,
  ResolvedWorkspaceView,
} from '../../../../../packages/workspace-packs/src/runtime';
import { useWorkspaceNavigation, useWorkspaceQueries, useWorkspaceSelection, useWorkspaceSession } from '../state';
import { FileTreePane } from '../components/FileTreePane';
import { FeatureDrawer } from '../drawer/FeatureDrawer';
import { NodeDrawer } from '../drawer/NodeDrawer';
import { projectTechnicalExpansion } from '../technicalExpansion';
import { useTechnicalExpansion } from '../technicalExpansionState';
import { isStructuralEdge } from '../types';
import { LegacyWorkspaceView } from '../views/LegacyWorkspaceView';
import { OnboardingWorkspaceView } from '../views/OnboardingWorkspaceView';
import { PitchSummaryPanel } from '../views/PitchSummaryPanel';
import { ProductWorkspaceView } from '../views/ProductWorkspaceView';
import { TechnicalWorkspaceView } from '../views/TechnicalWorkspaceView';
import { workspaceCapabilities } from './capabilityCatalog';
import { workspaceRegistrySnapshot } from './runtimeCatalog';

export interface WorkspaceCatalogComponentProps<Props extends JsonObject = JsonObject> {
  config: Readonly<Props>;
  region: ResolvedWorkspaceRegion;
  view: ResolvedWorkspaceView;
}

export interface WorkspaceComponentRuntimeState {
  viewId: string;
  fileTreeOpen: boolean;
  inspectorOpen: boolean;
  settingsOpen: boolean;
  selectedNodeId: string | null;
  selectedFeatureId: string | null;
}

export interface WorkspaceComponentDefinition<Props extends JsonObject = JsonObject>
  extends WorkspaceComponentContract<Props> {
  Component: ComponentType<WorkspaceCatalogComponentProps<Props>>;
  landmarkLabel: string;
  isPresent?(state: Readonly<WorkspaceComponentRuntimeState>): boolean;
}

export interface WorkspaceComponentCatalog {
  runtimeContractVersion: number;
  components: ReadonlyMap<string, WorkspaceComponentDefinition>;
  contract: WorkspaceComponentCatalogContract;
}

function parseEmptyProps(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new Error('This component accepts no configuration properties.');
  }
  return {};
}

function PrimarySurface({ view }: WorkspaceCatalogComponentProps) {
  const surface = <LegacyWorkspaceView />;
  if (view.id === 'product') return <ProductWorkspaceView>{surface}</ProductWorkspaceView>;
  if (view.id === 'onboarding') return <OnboardingWorkspaceView>{surface}</OnboardingWorkspaceView>;
  return <TechnicalWorkspaceView>{surface}</TechnicalWorkspaceView>;
}

function ExplorerContribution() {
  const { graph, graphStatus } = useWorkspaceQueries();
  const { repository } = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  const expansion = useTechnicalExpansion();
  const projection = projectTechnicalExpansion(
    graph.nodes,
    graph.edges.filter(isStructuralEdge),
    { ...expansion.preferences, focusNodeId: selection.selectedNodeId, transientReveal: expansion.transientReveal },
    Math.max(graph.nodes.length, 500),
  );
  return (
    <FileTreePane
      hidden={false}
      nodes={graph.nodes}
      status={graphStatus}
      repositoryLabel={repository?.name.split('/').pop() ?? '/'}
      search={navigation.search}
      selectedNodeId={selection.selectedNodeId}
      expandedFolderIds={projection.expandedFolderIds}
      pinnedNodeIds={expansion.preferences.pinnedBranches}
      onSelect={selection.selectNode}
      onSearchChange={navigation.setSearch}
      onSetFolderExpanded={expansion.setFolderExpanded}
      onCollapseAll={expansion.collapseAllFolders}
      onTogglePin={expansion.togglePinned}
      onClose={() => navigation.setFileTreeOpen(false)}
    />
  );
}

function InspectorContribution() {
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  if (!selection.inspectorOpen || navigation.settingsSection !== null) return null;
  if (selection.selectedNodeId !== null) return <NodeDrawer />;
  if (selection.selectedFeatureId !== null) return <FeatureDrawer />;
  return null;
}

function PitchSummaryContribution() {
  const { graph, semanticState } = useWorkspaceQueries();
  const nodePaths = new Map(graph.nodes.map((node) => [node.id, node.path]));
  const features = semanticState.status === 'ready' || semanticState.status === 'degraded'
    ? graph.features.map((feature) => ({
        id: feature.id,
        name: feature.name,
        description: feature.description,
        team: feature.team,
        files: feature.memberIds.flatMap((id) => nodePaths.get(id) ?? []),
        recentChanges: feature.recentEdits.map((edit) =>
          edit.pullRequestTitle ?? `${edit.filePath} edited by ${edit.editorName ?? edit.editorLogin ?? 'a teammate'}`,
        ),
      }))
    : [];
  return <PitchSummaryPanel summary={{ features }} />;
}

function requireManifest<T extends { id: string; version: number }>(items: readonly T[], id: string, version: number): T {
  const found = items.find((item) => item.id === id && item.version === version);
  if (found === undefined) throw new Error(`Workspace registry is missing "${id}@${version}".`);
  return found;
}

const structureCapability = requireManifest(workspaceRegistrySnapshot.dataCapabilities, 'sayre.structure', 1);
const treeListRenderer = requireManifest(workspaceRegistrySnapshot.renderers, 'sayre.tree-list', 1);
const featuresCapability = requireManifest(workspaceRegistrySnapshot.dataCapabilities, 'sayre.features', 1);
const pitchSummaryPanelRenderer = requireManifest(workspaceRegistrySnapshot.renderers, 'sayre.pitch-summary-panel', 1);

const definitions: readonly WorkspaceComponentDefinition[] = [
  {
    // Legacy hand-wired composite; FE-ARCH-02 does not migrate this one.
    id: 'sayre.primary-surface', version: 1, allowedSlots: ['primary'], requiredCapabilities: [], minimumRole: 'member',
    parseProps: parseEmptyProps, Component: PrimarySurface, landmarkLabel: 'Workspace canvas',
  },
  {
    // Derived from the structure x tree-list registry binding (FE-ARCH-02), not hand-wired.
    id: 'sayre.explorer', version: 1, allowedSlots: treeListRenderer.allowedSlots, requiredCapabilities: structureCapability.requiredGates, minimumRole: 'member',
    parseProps: parseEmptyProps, Component: ExplorerContribution, landmarkLabel: 'Repository explorer',
    isPresent: (state) => state.fileTreeOpen,
  },
  {
    // Legacy hand-wired composite; FE-ARCH-02 does not migrate this one.
    id: 'sayre.inspector', version: 1, allowedSlots: ['inspector'], requiredCapabilities: [], minimumRole: 'member',
    parseProps: parseEmptyProps, Component: InspectorContribution, landmarkLabel: 'Selection inspector',
    isPresent: (state) => state.inspectorOpen
      && !state.settingsOpen
      && (state.selectedNodeId !== null || state.selectedFeatureId !== null),
  },
  {
    // Derived from the features x pitch-summary-panel registry binding (FE-ARCH-02), not hand-wired.
    id: 'sayre.pitch-summary', version: 1, allowedSlots: pitchSummaryPanelRenderer.allowedSlots, requiredCapabilities: featuresCapability.requiredGates, minimumRole: 'member',
    parseProps: parseEmptyProps, Component: PitchSummaryContribution, landmarkLabel: 'Pitch summary',
  },
];

export function workspaceComponentKey(ref: WorkspaceComponentRef): string {
  return `${ref.id}@${ref.version}`;
}

export function snapshotWorkspaceComponentCatalog(catalog: WorkspaceComponentCatalog): WorkspaceComponentCatalogContract {
  return catalog.contract;
}

export function createWorkspaceComponentCatalog(): WorkspaceComponentCatalog {
  const components = new Map(definitions.map((definition) => [workspaceComponentKey(definition), definition]));
  const contract: WorkspaceComponentCatalogContract = {
    runtimeContractVersion: 1,
    components: definitions.map(({ Component: _Component, parseProps: _parseProps, landmarkLabel: _label, isPresent: _isPresent, ...definition }) => definition),
    capabilities: workspaceCapabilities,
  };
  return { runtimeContractVersion: 1, components, contract };
}

export const workspaceComponentCatalog = createWorkspaceComponentCatalog();

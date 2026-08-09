'use client';

import { useMemo, type ReactNode } from 'react';
import { OnboardingTreeCanvas } from '../canvas/OnboardingTreeCanvas';
import { rendererFor } from '../rendererRegistry';
import { useWorkspaceNavigation, useWorkspaceQueries, useWorkspaceSelection } from '../state';
import { projectTechnicalExpansion, viewportTechnicalNodeBudget } from '../technicalExpansion';
import { isStructuralEdge } from '../types';
import { useMeasuredWorkspaceCanvas, WorkspaceViewRuntimeProvider, type WorkspaceViewCanvasProps } from './WorkspaceViewRuntime';

export const onboardingWorkspaceContribution = Object.freeze({
  id: 'onboarding',
  capability: 'sayre.onboarding',
  surface: 'sayre.primary-surface@1',
});

export function OnboardingWorkspaceView({ children }: { children: ReactNode }) {
  const { graph } = useWorkspaceQueries();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  const { canvasRef, canvasSize } = useMeasuredWorkspaceCanvas();
  const normalizedSearch = navigation.search.trim().toLowerCase();
  const searchMatchIds = useMemo(() => normalizedSearch.length === 0
    ? new Set<string>()
    : new Set(graph.nodes.filter((node) => node.name.toLowerCase().includes(normalizedSearch)
      || node.path.toLowerCase().includes(normalizedSearch)).map((node) => node.id)),
  [graph.nodes, normalizedSearch]);
  const landmarkIds = useMemo(() => {
    const landmarkNames = new Set([
      'readme.md', 'agents.md', 'contributing.md', 'package.json', 'pnpm-workspace.yaml',
      '.env.example', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
    ]);
    const rootIds = new Set(graph.nodes.filter((node) => node.parentId === null).map((node) => node.id));
    return new Set(graph.nodes.filter((node) => node.kind === 'File' && node.parentId !== null
      && rootIds.has(node.parentId) && landmarkNames.has(node.name.toLowerCase())).map((node) => node.id));
  }, [graph.nodes]);
  const transientReveal = useMemo(() => normalizedSearch.length > 0
    ? { source: 'search' as const, nodeIds: searchMatchIds }
    : { source: 'onboarding' as const, nodeIds: landmarkIds },
  [landmarkIds, normalizedSearch, searchMatchIds]);
  const projection = useMemo(() => projectTechnicalExpansion(
    graph.nodes,
    graph.edges.filter(isStructuralEdge),
    {
      mode: 'focus', manuallyExpanded: new Set(), manuallyCollapsed: new Set(), pinnedBranches: new Set(),
      manualOrder: [], focusNodeId: selection.selectedNodeId, transientReveal,
    },
    Math.min(viewportTechnicalNodeBudget(canvasSize.width, canvasSize.height), 18),
  ), [canvasSize.height, canvasSize.width, graph.edges, graph.nodes, selection.selectedNodeId, transientReveal]);
  const renderer = rendererFor('onboarding', projection.nodes.length);
  const value = {
    id: 'onboarding' as const,
    title: 'Onboarding Tree',
    loadingLabel: 'Onboarding',
    visibleNodeCount: projection.nodes.length,
    visibleEdgeCount: projection.edges.length,
    renderer,
    countLabel: `${projection.nodes.length} context nodes`,
    canvasRef,
    renderCanvas: ({ command, showMinimap, fitKey, graphRootLabel }: WorkspaceViewCanvasProps) => graph.onboarding === null ? null : (
      <OnboardingTreeCanvas
        key={graph.onboarding.revisionSha}
        graphNodes={projection.nodes}
        prerequisite={graph.prerequisite}
        totalNodeCount={graph.nodes.length}
        rootLabel={graphRootLabel}
        workflow={graph.onboarding}
        renderer={renderer.id}
        command={command}
        selectedId={selection.selectedNodeId}
        search={navigation.search}
        showMinimap={showMinimap}
        fitKey={fitKey}
        onSelect={selection.selectNode}
      />
    ),
    statusLine: `ordered setup · ${graph.onboarding?.steps.length ?? 0} suggested steps`,
  };
  return <WorkspaceViewRuntimeProvider value={value}><section data-workspace-view="onboarding">{children}</section></WorkspaceViewRuntimeProvider>;
}

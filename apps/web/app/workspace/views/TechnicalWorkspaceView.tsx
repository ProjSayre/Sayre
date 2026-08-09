'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { TechnicalTreeCanvas } from '../canvas/TechnicalTreeCanvas';
import { rendererFor } from '../rendererRegistry';
import { useWorkspaceNavigation, useWorkspaceQueries, useWorkspaceSelection, useWorkspaceSession } from '../state';
import { projectTechnicalExpansion, viewportTechnicalNodeBudget } from '../technicalExpansion';
import { useTechnicalExpansion } from '../technicalExpansionState';
import { isStructuralEdge } from '../types';
import { useMeasuredWorkspaceCanvas, WorkspaceViewRuntimeProvider } from './WorkspaceViewRuntime';

export const technicalWorkspaceContribution = Object.freeze({
  id: 'technical',
  capability: 'sayre.technical',
  surface: 'sayre.primary-surface@1',
});

export function TechnicalWorkspaceView({ children }: { children: ReactNode }) {
  const { graph } = useWorkspaceQueries();
  const { repository } = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  const expansion = useTechnicalExpansion();
  const { clearTransientReveal } = expansion;
  const { canvasRef, canvasSize } = useMeasuredWorkspaceCanvas();
  const [graphExpansionAnchorId, setGraphExpansionAnchorId] = useState<string | null>(null);
  const normalizedSearch = navigation.search.trim().toLowerCase();
  const searchMatchIds = useMemo(() => normalizedSearch.length === 0
    ? new Set<string>()
    : new Set(graph.nodes.filter((node) => node.name.toLowerCase().includes(normalizedSearch)
      || node.path.toLowerCase().includes(normalizedSearch)).map((node) => node.id)),
  [graph.nodes, normalizedSearch]);
  const selectedDependencyIds = useMemo(() => {
    if (selection.selectedNodeId === null) return new Set<string>();
    const ids = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.type !== 'IMPORTS') continue;
      if (edge.source === selection.selectedNodeId) ids.add(edge.target);
      if (edge.target === selection.selectedNodeId) ids.add(edge.source);
    }
    return ids;
  }, [graph.edges, selection.selectedNodeId]);
  const effectiveTransientReveal = useMemo(() => {
    if (normalizedSearch.length > 0) return { source: 'search' as const, nodeIds: searchMatchIds };
    if (expansion.transientReveal !== null) return expansion.transientReveal;
    return selectedDependencyIds.size > 0 ? { source: 'selection' as const, nodeIds: selectedDependencyIds } : null;
  }, [expansion.transientReveal, normalizedSearch, searchMatchIds, selectedDependencyIds]);
  const projection = useMemo(() => projectTechnicalExpansion(
    graph.nodes,
    graph.edges.filter(isStructuralEdge),
    { ...expansion.preferences, focusNodeId: selection.selectedNodeId, transientReveal: effectiveTransientReveal },
    viewportTechnicalNodeBudget(canvasSize.width, canvasSize.height),
  ), [canvasSize.height, canvasSize.width, effectiveTransientReveal, expansion.preferences, graph.edges, graph.nodes, selection.selectedNodeId]);
  const rawCoverageSummary = graph.nodes.reduce((summary, node) => {
    if (node.kind === 'File') summary[node.coverage?.status ?? 'unknown'] += 1;
    return summary;
  }, { pass: 0, fail: 0, stale: 0, unknown: 0 });
  const coverageSummary = rawCoverageSummary.pass + rawCoverageSummary.fail + rawCoverageSummary.stale > 0
    ? rawCoverageSummary : null;
  const uniqueTransientFocusId = effectiveTransientReveal !== null && effectiveTransientReveal.nodeIds.size === 1
    ? effectiveTransientReveal.nodeIds.values().next().value ?? null : null;

  useEffect(() => {
    setGraphExpansionAnchorId(null);
  }, [navigation.refName, navigation.search, repository?.id]);

  useEffect(() => {
    if (selection.selectedNodeId === null) clearTransientReveal('deep-link');
  }, [clearTransientReveal, selection.selectedNodeId]);

  const selectNode = useCallback((nodeId: string) => {
    setGraphExpansionAnchorId((current) => current === nodeId ? current : null);
    selection.selectNode(nodeId);
  }, [selection]);

  const value = {
    id: 'technical' as const,
    title: 'Technical Tree',
    loadingLabel: 'Technical Tree',
    visibleNodeCount: projection.nodes.length,
    visibleEdgeCount: projection.edges.length,
    renderer: rendererFor('technical', projection.nodes.length),
    coverageSummary,
    technicalExpansion: {
      mode: expansion.preferences.mode,
      totalNodeCount: graph.nodes.length,
      budget: projection.budget,
      foldedBranchCount: projection.foldedBranchCount,
      transientMatchCount: projection.transientMatchCount,
      visibleTransientMatchCount: projection.visibleTransientMatchCount,
      transientSource: effectiveTransientReveal?.source ?? null,
      overBudgetBy: projection.overBudgetBy,
      onModeChange: (mode: 'balanced' | 'focus' | 'full') => {
        setGraphExpansionAnchorId(null);
        expansion.setMode(mode);
      },
      onReset: () => {
        setGraphExpansionAnchorId(null);
        expansion.reset();
      },
    },
    canvasRef,
    renderCanvas: ({ command, showMinimap, fitKey, graphRootLabel }: {
      command: Parameters<typeof TechnicalTreeCanvas>[0]['command'];
      showMinimap: boolean;
      fitKey: string;
      graphRootLabel: string;
    }) => (
      <TechnicalTreeCanvas
        graphNodes={projection.nodes}
        graphEdges={projection.edges}
        rootLabel={graphRootLabel}
        renderer={rendererFor('technical', projection.nodes.length).id}
        command={command}
        selectedId={selection.selectedNodeId}
        cameraFocusId={graphExpansionAnchorId ?? selection.selectedNodeId ?? uniqueTransientFocusId}
        preserveCameraZoom={graphExpansionAnchorId !== null}
        search={navigation.search}
        showMinimap={showMinimap}
        fitKey={fitKey}
        layoutKey={projection.key}
        expansion={projection}
        onSelect={selectNode}
        onSetFolderExpanded={(nodeId, expanded) => {
          setGraphExpansionAnchorId(nodeId);
          expansion.setFolderExpanded(nodeId, expanded);
        }}
        onTogglePinned={(nodeId) => {
          setGraphExpansionAnchorId(nodeId);
          expansion.togglePinned(nodeId);
        }}
        onRequestFullGraph={(nodeId) => {
          setGraphExpansionAnchorId(nodeId);
          expansion.setMode('full');
        }}
      />
    ),
    statusLine: `${expansion.preferences.mode === 'balanced' ? 'overview' : expansion.preferences.mode === 'full' ? 'everything' : 'focus'} · ${projection.nodes.length} of ${graph.nodes.length} shown · ${projection.foldedBranchCount} collapsed branches`,
  };

  return <WorkspaceViewRuntimeProvider value={value}><section data-workspace-view="technical">{children}</section></WorkspaceViewRuntimeProvider>;
}

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentSkillVersion, LoadStatus, NodeOverlay, SemanticState, SemanticStatus, WorkspaceGraph } from '../types';
import { workspaceView } from '../viewRegistry';
import { useWorkspaceSession } from './session';
import { statusOf, useWorkspaceStore } from './store';

export interface WorkspaceQueryContextValue {
  graph: WorkspaceGraph; graphStatus: LoadStatus; graphErrorStatus: number | null; semanticState: SemanticState;
  nodeOverlay: NodeOverlay | null; overlayStatus: LoadStatus; reloadGraph(): void; reloadOverlay(): void;
}

interface WorkspaceQueryMutationContextValue {
  commitAgentSkill(nodeId: string, saved: AgentSkillVersion): void;
}

const WorkspaceQueryContext = createContext<WorkspaceQueryContextValue | null>(null);
const WorkspaceQueryMutationContext = createContext<WorkspaceQueryMutationContextValue | null>(null);
const EMPTY_GRAPH: WorkspaceGraph = { nodes: [], edges: [], features: [], onboarding: null, prerequisite: null, productCoverage: null };
const SEMANTIC_REASONS: Record<SemanticStatus, string | null> = {
  generating: null,
  ready: null,
  degraded: 'Semantic features are temporarily degraded. Repository structure remains available.',
  failed: 'Product Tree generation did not complete. Repository structure remains available.',
};

export function WorkspaceQueryProvider({ children }: { children: ReactNode }) {
  const { state, dispatch, source } = useWorkspaceStore();
  const { authorizedForRepository, readiness, scope } = useWorkspaceSession();
  const [graphVersion, setGraphVersion] = useState(0);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const [graph, setGraph] = useState<WorkspaceGraph>(EMPTY_GRAPH);
  const [graphStatus, setGraphStatus] = useState<LoadStatus>('idle');
  const [graphErrorStatus, setGraphErrorStatus] = useState<number | null>(null);
  const [providerSemantic, setProviderSemantic] = useState<SemanticState>({ status: 'generating', reasonCode: null, reason: null, updatedAt: null });
  const [nodeOverlay, setNodeOverlay] = useState<NodeOverlay | null>(null);
  const [overlayStatus, setOverlayStatus] = useState<LoadStatus>('idle');
  const reloadGraph = useCallback(() => setGraphVersion((version) => version + 1), []);
  const reloadOverlay = useCallback(() => setOverlayVersion((version) => version + 1), []);
  const selectionRef = useRef({ nodeId: state.selectedNodeId, featureId: state.selectedFeatureId });

  useEffect(() => {
    selectionRef.current = { nodeId: state.selectedNodeId, featureId: state.selectedFeatureId };
  }, [state.selectedFeatureId, state.selectedNodeId]);

  useEffect(() => {
    if (scope === null || !authorizedForRepository || readiness === 'registered' || !workspaceView(state.view).enabled) {
      setGraph(EMPTY_GRAPH);
      setGraphStatus('idle');
      setGraphErrorStatus(null);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setGraphStatus('loading');
    setGraphErrorStatus(null);
    void workspaceView(state.view).load(source, scope, controller.signal).then((nextGraph) => {
      if (!active) return;
      setGraph(nextGraph);
      setGraphStatus('ready');
      const selected = selectionRef.current;
      if ((selected.nodeId !== null && !nextGraph.nodes.some((node) => node.id === selected.nodeId))
        || (selected.featureId !== null && !nextGraph.features.some((feature) => feature.id === selected.featureId))) {
        dispatch({ type: 'clearSelection' });
      }
      dispatch({ type: 'patch', patch: { backend: 'available' } });
    }).catch((error: unknown) => {
      if (!active || (error as { name?: string }).name === 'AbortError') return;
      setGraph(EMPTY_GRAPH);
      setGraphStatus('error');
      const status = statusOf(error);
      setGraphErrorStatus(status);
      if (status === 401) dispatch({ type: 'patch', patch: { session: 'session-expired' } });
    });
    return () => { active = false; controller.abort(); };
  }, [authorizedForRepository, dispatch, graphVersion, readiness, scope, source, state.view]);

  useEffect(() => {
    if (scope === null || readiness === 'registered') {
      setProviderSemantic({ status: 'generating', reasonCode: null, reason: null, updatedAt: null });
      return;
    }
    let active = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const providerSurface = state.view === 'onboarding' ? 'onboarding' : 'product';
    const refresh = (): void => {
      controller = new AbortController();
      void source.providerState(scope, providerSurface, controller.signal).then((providerState) => {
        if (!active) return;
        const status = providerState?.status ?? (providerSurface === 'onboarding'
          ? (graph.onboarding !== null ? 'ready' : 'generating')
          : (graph.features.length > 0 ? 'ready' : 'generating'));
        setProviderSemantic({ status, reasonCode: providerState?.reasonCode ?? null, reason: SEMANTIC_REASONS[status], updatedAt: providerState?.updatedAt ?? null });
      }).catch((error: unknown) => {
        if (!active || (error as { name?: string }).name === 'AbortError') return;
        if (statusOf(error) === 401) dispatch({ type: 'patch', patch: { session: 'session-expired' } });
        const status = providerSurface === 'onboarding'
          ? (graph.onboarding !== null ? 'ready' : 'generating')
          : (graph.features.length > 0 ? 'ready' : 'generating');
        setProviderSemantic({ status, reasonCode: null, reason: null, updatedAt: null });
      }).finally(() => { if (active) timer = setTimeout(refresh, 5_000); });
    };
    refresh();
    return () => { active = false; controller?.abort(); if (timer !== null) clearTimeout(timer); };
  }, [dispatch, graph.features.length, graph.onboarding, readiness, scope, source, state.view]);

  useEffect(() => {
    const nodeId = state.selectedNodeId;
    if (nodeId === null) {
      setNodeOverlay(null);
      setOverlayStatus('idle');
      return;
    }
    const controller = new AbortController();
    let active = true;
    setNodeOverlay(null);
    setOverlayStatus('loading');
    void source.nodeOverlay(nodeId, controller.signal).then((nextOverlay) => {
      if (!active) return;
      setNodeOverlay(nextOverlay);
      setOverlayStatus('ready');
    }).catch((error: unknown) => {
      if (!active || (error as { name?: string }).name === 'AbortError') return;
      if (statusOf(error) === 401) dispatch({ type: 'patch', patch: { session: 'session-expired' } });
      setOverlayStatus('error');
    });
    return () => { active = false; controller.abort(); };
  }, [dispatch, overlayVersion, source, state.selectedNodeId]);

  const semanticState = useMemo<SemanticState>(() => source.id === 'fixture'
    ? { status: state.semantic, reasonCode: null, reason: SEMANTIC_REASONS[state.semantic], updatedAt: '2026-07-25T14:12:00Z' }
    : providerSemantic, [providerSemantic, source.id, state.semantic]);
  const value = useMemo<WorkspaceQueryContextValue>(() => ({ graph, graphStatus, graphErrorStatus, semanticState, nodeOverlay, overlayStatus, reloadGraph, reloadOverlay }), [graph, graphErrorStatus, graphStatus, nodeOverlay, overlayStatus, reloadGraph, reloadOverlay, semanticState]);
  const mutations = useMemo<WorkspaceQueryMutationContextValue>(() => ({
    commitAgentSkill(nodeId, saved) {
      setNodeOverlay((current) => current?.nodeId === nodeId ? {
        ...current,
        agentSkillMd: saved,
        agentSkillHistory: current.agentSkillMd === null ? current.agentSkillHistory : [current.agentSkillMd, ...current.agentSkillHistory],
      } : current);
    },
  }), []);
  return <WorkspaceQueryContext.Provider value={value}><WorkspaceQueryMutationContext.Provider value={mutations}>{children}</WorkspaceQueryMutationContext.Provider></WorkspaceQueryContext.Provider>;
}

export function useWorkspaceQueries(): WorkspaceQueryContextValue {
  const value = useContext(WorkspaceQueryContext);
  if (value === null) throw new Error('useWorkspaceQueries must be used inside WorkspaceQueryProvider.');
  return value;
}

export function useWorkspaceQueryMutations(): WorkspaceQueryMutationContextValue {
  const value = useContext(WorkspaceQueryMutationContext);
  if (value === null) throw new Error('Workspace operations require WorkspaceQueryProvider.');
  return value;
}

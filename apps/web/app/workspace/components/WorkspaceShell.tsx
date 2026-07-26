'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useMock } from '../state';
import {
  rendererFor,
  type CanvasCommand,
  type CanvasCommandType,
} from '../rendererRegistry';
import { themeVariables, warmGraphiteTheme } from '../theme';
import { ProductTreeCanvas } from '../canvas/ProductTreeCanvas';
import { TechnicalTreeCanvas } from '../canvas/TechnicalTreeCanvas';
import { OnboardingTreeCanvas } from '../canvas/OnboardingTreeCanvas';
import { FeatureDrawer } from '../drawer/FeatureDrawer';
import { NodeDrawer } from '../drawer/NodeDrawer';
import { SettingsPanel } from '../settings/SettingsPanel';
import { AskSayreDock } from './AskSayrePanel';
import {
  EmptyGraphState,
  ForbiddenState,
  LoadingState,
  NoRepositoryState,
  PreparingState,
  ProductUnavailableState,
  UnavailableState,
} from './CanvasStates';
import { CanvasToolbar } from './CanvasToolbar';
import { ControlPanel } from '../../mock/components/ControlPanel';
import { FileTreePane } from './FileTreePane';
import { GlobalStates } from './GlobalStates';
import { StatusBanner } from './StatusBanner';
import { TopBar } from './TopBar';
import { ViewRail } from './ViewRail';
import {
  projectTechnicalExpansion,
  viewportTechnicalNodeBudget,
} from '../technicalExpansion';
import {
  TechnicalExpansionProvider,
  useTechnicalExpansion,
} from '../technicalExpansionState';

type CanvasStatus =
  | 'no-repository'
  | 'forbidden'
  | 'preparing'
  | 'loading'
  | 'empty'
  | 'unavailable'
  | 'product-unavailable'
  | 'ready';

function Workspace() {
  const {
    state,
    dispatch,
    repository,
    authorizedForRepository,
    readiness,
    semanticState,
    graph,
    graphStatus,
    graphErrorStatus,
  } = useMock();
  const technicalExpansion = useTechnicalExpansion();
  const [showMinimap, setShowMinimap] = useState(true);
  const [canvasCommand, setCanvasCommand] = useState<CanvasCommand | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({
    width: 880,
    height: 600,
  });

  useEffect(() => {
    const element = canvasRef.current;
    if (element === null) return undefined;
    const update = (): void => {
      const bounds = element.getBoundingClientRect();
      const next = {
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      };
      setCanvasSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function commandCanvas(type: CanvasCommandType): void {
    setCanvasCommand((current) => ({ id: (current?.id ?? 0) + 1, type }));
  }

  const isTechnical = state.view === 'technical';
  const isProduct = state.view === 'product';
  const isOnboarding = state.view === 'onboarding';

  const status: CanvasStatus = ((): CanvasStatus => {
    if (repository === null) return 'no-repository';
    if (!authorizedForRepository) return 'forbidden';
    if (readiness === 'registered') return 'preparing';
    if (
      state.canvasData === 'loading' ||
      graphStatus === 'idle' ||
      graphStatus === 'loading'
    ) {
      return 'loading';
    }
    if (graphStatus === 'error') {
      return graphErrorStatus === 403 ? 'forbidden' : 'unavailable';
    }
    if (isOnboarding && graph.onboarding === null) return 'unavailable';
    if (
      isProduct &&
      (semanticState.status === 'generating' || semanticState.status === 'failed')
    ) {
      return 'product-unavailable';
    }
    if (state.canvasData === 'empty' || graph.nodes.length === 0) return 'empty';
    return 'ready';
  })();

  const ready = status === 'ready';
  const canvasBudget = viewportTechnicalNodeBudget(
    canvasSize.width,
    canvasSize.height,
  );
  const normalizedSearch = state.search.trim().toLowerCase();
  const searchMatchIds = useMemo(
    () =>
      normalizedSearch.length === 0
        ? new Set<string>()
        : new Set(
            graph.nodes
              .filter(
                (node) =>
                  node.name.toLowerCase().includes(normalizedSearch) ||
                  node.path.toLowerCase().includes(normalizedSearch),
              )
              .map((node) => node.id),
          ),
    [graph.nodes, normalizedSearch],
  );
  const effectiveTransientReveal = useMemo(
    () =>
      normalizedSearch.length === 0
        ? technicalExpansion.transientReveal
        : { source: 'search' as const, nodeIds: searchMatchIds },
    [
      normalizedSearch,
      searchMatchIds,
      technicalExpansion.transientReveal,
    ],
  );
  const technicalProjection = useMemo(
    () =>
      projectTechnicalExpansion(
        graph.nodes,
        graph.edges,
        {
          ...technicalExpansion.preferences,
          focusNodeId: state.selectedNodeId,
          transientReveal: effectiveTransientReveal,
        },
        canvasBudget,
      ),
    [
      canvasBudget,
      graph.edges,
      graph.nodes,
      effectiveTransientReveal,
      state.selectedNodeId,
      technicalExpansion.preferences,
    ],
  );
  const onboardingProjection = useMemo(
    () =>
      projectTechnicalExpansion(
        graph.nodes,
        graph.edges,
        {
          mode: 'focus',
          manuallyExpanded: new Set(),
          manuallyCollapsed: new Set(),
          pinnedBranches: new Set(),
          manualOrder: [],
          focusNodeId: state.selectedNodeId,
          transientReveal: effectiveTransientReveal,
        },
        Math.min(canvasBudget, 18),
      ),
    [
      canvasBudget,
      effectiveTransientReveal,
      graph.edges,
      graph.nodes,
      state.selectedNodeId,
    ],
  );
  const uniqueTransientFocusId =
    effectiveTransientReveal !== null &&
    effectiveTransientReveal.nodeIds.size === 1
      ? effectiveTransientReveal.nodeIds.values().next().value ?? null
      : null;
  const visibleNodeCount = isTechnical
    ? technicalProjection.nodes.length
    : isOnboarding
      ? onboardingProjection.nodes.length
      : graph.nodes.length;
  const visibleEdgeCount = isTechnical
    ? technicalProjection.edges.length
    : isOnboarding
      ? onboardingProjection.edges.length
      : graph.edges.length;
  const renderer = rendererFor(state.view, visibleNodeCount);
  const coverageSummary =
    ready && isTechnical
      ? graph.nodes.reduce(
          (summary, node) => {
            if (node.kind === 'File') {
              summary[node.coverage?.status ?? 'unknown'] += 1;
            }
            return summary;
          },
          { pass: 0, fail: 0, stale: 0, unknown: 0 },
        )
      : null;
  const scopeLabel =
    state.selectedNodeId !== null
      ? 'selected node'
      : repository === null
        ? 'no repository'
        : repository.name;
  const graphRootLabel =
    repository === null
      ? '/'
      : `${repository.name.split('/').pop() ?? repository.name}/`;

  return (
    <main className="mock-main">
      <CanvasToolbar
        title={
          isTechnical
            ? 'Technical Tree'
            : isProduct
              ? 'Product Tree'
              : 'Onboarding Tree'
        }
        visibleNodeCount={ready ? visibleNodeCount : 0}
        edgeCount={ready && !isProduct ? visibleEdgeCount : null}
        renderer={renderer}
        coverageSummary={coverageSummary}
        technicalExpansion={
          isTechnical
            ? {
                mode: technicalExpansion.preferences.mode,
                totalNodeCount: graph.nodes.length,
                budget: technicalProjection.budget,
                foldedBranchCount: technicalProjection.foldedBranchCount,
                transientMatchCount:
                  technicalProjection.transientMatchCount,
                visibleTransientMatchCount:
                  technicalProjection.visibleTransientMatchCount,
                transientSource:
                  effectiveTransientReveal?.source ?? null,
                overBudgetBy: technicalProjection.overBudgetBy,
                onModeChange: technicalExpansion.setMode,
                onReset: technicalExpansion.reset,
              }
            : null
        }
        interactive={ready}
        showMinimap={showMinimap}
        onToggleMinimap={() => setShowMinimap((value) => !value)}
        onCommand={commandCanvas}
      />

      {/* Same reason as the top-bar badges: no processing state for a
          repository the viewer cannot read. */}
      {repository !== null && authorizedForRepository && !isOnboarding && (
        <StatusBanner />
      )}

      <div className="mock-canvas" ref={canvasRef}>
        {status === 'no-repository' && (
          <NoRepositoryState
            reason={state.access === 'no-repositories' ? 'none' : 'restricted'}
          />
        )}
        {status === 'preparing' && repository !== null && (
          <PreparingState repositoryLabel={repository.name} />
        )}
        {status === 'forbidden' && <ForbiddenState />}
        {status === 'loading' && <LoadingState />}
        {status === 'empty' && <EmptyGraphState />}
        {status === 'unavailable' && <UnavailableState />}
        {status === 'product-unavailable' && (
          <ProductUnavailableState
            reason={semanticState.status === 'failed' ? 'failed' : 'generating'}
          />
        )}

        {ready && isTechnical && (
          <TechnicalTreeCanvas
            graphNodes={technicalProjection.nodes}
            graphEdges={technicalProjection.edges}
            rootLabel={graphRootLabel}
            renderer={renderer.id}
            command={canvasCommand}
            selectedId={state.selectedNodeId}
            cameraFocusId={state.selectedNodeId ?? uniqueTransientFocusId}
            search={state.search}
            showMinimap={showMinimap}
            fitKey={`${state.drawerOpen}:${state.controlsOpen}:${state.fileTreeOpen}`}
            layoutKey={technicalProjection.key}
            expansion={technicalProjection}
            onSelect={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
            onSetFolderExpanded={technicalExpansion.setFolderExpanded}
            onTogglePinned={technicalExpansion.togglePinned}
            onRequestFullGraph={() => technicalExpansion.setMode('full')}
          />
        )}

        {ready && isProduct && (
          <ProductTreeCanvas
            graphNodes={graph.nodes}
            graphEdges={graph.edges}
            features={graph.features}
            command={canvasCommand}
            selectedFeatureId={state.selectedFeatureId}
            selectedNodeId={state.selectedNodeId}
            search={state.search}
            showMinimap={showMinimap}
            fitKey={`${state.drawerOpen}:${state.controlsOpen}:${state.fileTreeOpen}`}
            onSelectFeature={(featureId) =>
              dispatch({ type: 'selectFeature', featureId })
            }
            onSelectNode={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          />
        )}

        {ready && isOnboarding && graph.onboarding !== null && (
          <OnboardingTreeCanvas
            graphNodes={onboardingProjection.nodes}
            graphEdges={onboardingProjection.edges}
            totalNodeCount={graph.nodes.length}
            rootLabel={graphRootLabel}
            workflow={graph.onboarding}
            renderer={renderer.id}
            command={canvasCommand}
            selectedId={state.selectedNodeId}
            search={state.search}
            showMinimap={showMinimap}
            fitKey={`${state.drawerOpen}:${state.controlsOpen}:${state.fileTreeOpen}`}
            onSelect={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          />
        )}

        {ready && (
          <span className="mock-statusline">
            {isTechnical
              ? `${technicalExpansion.preferences.mode} · ${visibleNodeCount} of ${graph.nodes.length} visible · ${technicalProjection.foldedBranchCount} folded branches`
              : isProduct
                ? `feature graph · ${graph.features.length} features`
                : `ordered setup · ${graph.onboarding?.steps.length ?? 0} sandbox steps`}{' '}
            · showing only nodes you are authorized to see
          </span>
        )}
      </div>

      <AskSayreDock scopeLabel={scopeLabel} />

      <SettingsPanel />
    </main>
  );
}

function WorkspaceBody() {
  const {
    dispatch,
    graph,
    graphStatus,
    repository,
    scope,
    state,
  } = useMock();
  const technicalExpansion = useTechnicalExpansion();
  const drawerSelected =
    state.drawerOpen &&
    (state.selectedNodeId !== null || state.selectedFeatureId !== null);
  const drawerVisible =
    state.settingsSection === null && drawerSelected;
  const fileTreeVisible = state.view === 'technical' && state.fileTreeOpen;
  const fileTreeRootId =
    graph.nodes.find((node) => node.parentId === null)?.id ??
    graph.nodes[0]?.id ??
    'empty';

  return (
    <div
      className={[
        'mock-body',
        fileTreeVisible ? 'mock-body-explorer' : '',
        drawerVisible ? 'mock-body-drawer' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ViewRail />
      {state.view === 'technical' && (
        <FileTreePane
          hidden={!fileTreeVisible}
          nodes={graph.nodes}
          status={graphStatus}
          repositoryLabel={
            repository === null
              ? '/'
              : `${repository.name.split('/').pop() ?? repository.name}/`
          }
          treeKey={
            scope === null
              ? 'no-repository'
              : `${scope.repositoryId}:${scope.refName}:${fileTreeRootId}`
          }
          selectedNodeId={state.selectedNodeId}
          pinnedNodeIds={technicalExpansion.preferences.pinnedBranches}
          onSelect={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          onTogglePin={technicalExpansion.togglePinned}
          onClose={() =>
            dispatch({ type: 'patch', patch: { fileTreeOpen: false } })
          }
        />
      )}
      <ReactFlowProvider>
        <Workspace />
      </ReactFlowProvider>
      {drawerSelected && (
        <div className="mock-drawer-preserver" hidden={!drawerVisible}>
          {state.selectedNodeId !== null ? <NodeDrawer /> : <FeatureDrawer />}
        </div>
      )}
    </div>
  );
}

export function WorkspaceShell() {
  const { graph, graphStatus, mode, scope, state } = useMock();
  const globallyBlocked =
    state.session !== 'authenticated' ||
    state.backend === 'unavailable' ||
    state.access === 'forbidden';

  if (globallyBlocked) {
    return (
      <div className="mock-root" style={themeVariables(warmGraphiteTheme)}>
        <GlobalStates />
        {mode === 'fixture' && <ControlPanel />}
      </div>
    );
  }

  const expansionScopeKey =
    scope === null
      ? 'no-repository'
      : `${scope.repositoryId}:${scope.refName}`;

  return (
    <div className="mock-root" style={themeVariables(warmGraphiteTheme)}>
      <TopBar />
      <TechnicalExpansionProvider
        scopeKey={expansionScopeKey}
        nodes={
          state.view === 'technical' && graphStatus === 'ready'
            ? graph.nodes
            : null
        }
      >
        <WorkspaceBody />
      </TechnicalExpansionProvider>
      {mode === 'fixture' && <ControlPanel />}
    </div>
  );
}

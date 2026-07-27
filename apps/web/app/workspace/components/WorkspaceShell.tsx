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
  const clearTechnicalTransientReveal =
    technicalExpansion.clearTransientReveal;
  const [showMinimap, setShowMinimap] = useState(true);
  const [canvasCommand, setCanvasCommand] = useState<CanvasCommand | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({
    width: 880,
    height: 600,
  });

  useEffect(() => {
    if (state.view === 'technical' && state.selectedNodeId === null) {
      clearTechnicalTransientReveal('deep-link');
    }
  }, [
    state.selectedNodeId,
    state.view,
    clearTechnicalTransientReveal,
  ]);

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
  const searchResultCount = useMemo(() => {
    if (normalizedSearch.length === 0) return 0;
    const nodeMatches = searchMatchIds.size;
    if (!isProduct) return nodeMatches;
    const featureMatches = graph.features.filter((feature) =>
      [
        feature.name,
        feature.description ?? '',
        feature.team ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedSearch)),
    ).length;
    return nodeMatches + featureMatches;
  }, [
    graph.features,
    isProduct,
    normalizedSearch,
    searchMatchIds,
  ]);
  const selectedDependencyIds = useMemo(() => {
    if (!isTechnical || state.selectedNodeId === null) return new Set<string>();
    const ids = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.type !== 'IMPORTS') continue;
      if (edge.source === state.selectedNodeId) ids.add(edge.target);
      if (edge.target === state.selectedNodeId) ids.add(edge.source);
    }
    return ids;
  }, [graph.edges, isTechnical, state.selectedNodeId]);
  const effectiveTransientReveal = useMemo(
    () => {
      if (normalizedSearch.length > 0) {
        return { source: 'search' as const, nodeIds: searchMatchIds };
      }
      if (technicalExpansion.transientReveal !== null) {
        return technicalExpansion.transientReveal;
      }
      return selectedDependencyIds.size > 0
        ? {
            source: 'selection' as const,
            nodeIds: selectedDependencyIds,
          }
        : null;
    },
    [
      normalizedSearch,
      searchMatchIds,
      selectedDependencyIds,
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
  const onboardingLandmarkIds = useMemo(() => {
    const landmarkNames = new Set([
      'readme.md',
      'agents.md',
      'contributing.md',
      'package.json',
      'pnpm-workspace.yaml',
      '.env.example',
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml',
    ]);
    const rootIds = new Set(
      graph.nodes
        .filter((node) => node.parentId === null)
        .map((node) => node.id),
    );
    return new Set(
      graph.nodes
        .filter(
          (node) =>
            node.kind === 'File' &&
            node.parentId !== null &&
            rootIds.has(node.parentId) &&
            landmarkNames.has(node.name.toLowerCase()),
        )
        .map((node) => node.id),
    );
  }, [graph.nodes]);
  const onboardingTransientReveal = useMemo(
    () =>
      normalizedSearch.length > 0
        ? { source: 'search' as const, nodeIds: searchMatchIds }
        : {
            source: 'onboarding' as const,
            nodeIds: onboardingLandmarkIds,
          },
    [normalizedSearch, onboardingLandmarkIds, searchMatchIds],
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
          transientReveal: onboardingTransientReveal,
        },
        Math.min(canvasBudget, 18),
      ),
    [
      canvasBudget,
      graph.edges,
      graph.nodes,
      onboardingTransientReveal,
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
  const rawCoverageSummary =
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
  const coverageSummary =
    rawCoverageSummary !== null &&
    rawCoverageSummary.pass +
      rawCoverageSummary.fail +
      rawCoverageSummary.stale >
      0
      ? rawCoverageSummary
      : null;
  const graphRootLabel =
    repository === null
      ? '/'
      : `${repository.name.split('/').pop() ?? repository.name}/`;
  const fileTreeVisible = isTechnical && state.fileTreeOpen;

  return (
    <>
      {isTechnical && (
        <FileTreePane
          hidden={!fileTreeVisible}
          nodes={graph.nodes}
          status={graphStatus}
          repositoryLabel={graphRootLabel}
          selectedNodeId={state.selectedNodeId}
          expandedFolderIds={technicalProjection.expandedFolderIds}
          pinnedNodeIds={technicalExpansion.preferences.pinnedBranches}
          onSelect={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          onSetFolderExpanded={technicalExpansion.setFolderExpanded}
          onCollapseAll={technicalExpansion.collapseAllFolders}
          onTogglePin={technicalExpansion.togglePinned}
          onClose={() =>
            dispatch({ type: 'patch', patch: { fileTreeOpen: false } })
          }
        />
      )}
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
        countLabel={
          !ready
            ? undefined
            : isProduct
              ? `${graph.features.length} features · ${graph.productCoverage?.mappedFileCount ?? graph.nodes.length} mapped files`
              : isOnboarding
                ? `${visibleNodeCount} context nodes`
                : undefined
        }
        edgeCount={ready && !isProduct ? visibleEdgeCount : null}
        renderer={renderer}
        coverageSummary={coverageSummary}
        searchResultCount={
          normalizedSearch.length === 0 ? null : searchResultCount
        }
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
      {repository !== null && authorizedForRepository && (
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
        {status === 'loading' && (
          <LoadingState
            label={
              isTechnical
                ? 'Technical Tree'
                : isProduct
                  ? 'Product Tree'
                  : 'Onboarding'
            }
          />
        )}
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
            key={graph.onboarding.revisionSha}
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
              ? `${
                  technicalExpansion.preferences.mode === 'balanced'
                    ? 'overview'
                    : technicalExpansion.preferences.mode === 'full'
                      ? 'everything'
                      : 'focus'
                } · ${visibleNodeCount} of ${graph.nodes.length} shown · ${technicalProjection.foldedBranchCount} collapsed branches`
              : isProduct
                ? `feature map · ${graph.features.length} features${
                    graph.productCoverage === null
                      ? ''
                      : ` · ${graph.productCoverage.mappedFileCount}/${graph.productCoverage.totalFileCount} files mapped`
                  }`
                : `ordered setup · ${graph.onboarding?.steps.length ?? 0} suggested steps`}
          </span>
        )}
      </div>

      <SettingsPanel />
      </main>
    </>
  );
}

function WorkspaceBody() {
  const { state } = useMock();
  const drawerSelected =
    state.drawerOpen &&
    (state.selectedNodeId !== null || state.selectedFeatureId !== null);
  const drawerVisible =
    state.settingsSection === null && drawerSelected;
  const fileTreeVisible = state.view === 'technical' && state.fileTreeOpen;

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

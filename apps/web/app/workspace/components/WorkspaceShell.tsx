'use client';

import { useState } from 'react';
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
import { GlobalStates } from './GlobalStates';
import { StatusBanner } from './StatusBanner';
import { TopBar } from './TopBar';
import { ViewRail } from './ViewRail';

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
  const [showMinimap, setShowMinimap] = useState(true);
  const [canvasCommand, setCanvasCommand] = useState<CanvasCommand | null>(null);

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
  const visibleNodeCount = graph.nodes.length;
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
        edgeCount={ready && !isProduct ? graph.edges.length : null}
        renderer={renderer}
        coverageSummary={coverageSummary}
        interactive={ready}
        showMinimap={showMinimap}
        onToggleMinimap={() => setShowMinimap((value) => !value)}
        onCommand={commandCanvas}
      />

      {/* Same reason as the top-bar badges: no processing state for a
          repository the viewer cannot read. */}
      {repository !== null && authorizedForRepository && <StatusBanner />}

      <div className="mock-canvas">
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
            graphNodes={graph.nodes}
            graphEdges={graph.edges}
            renderer={renderer.id}
            command={canvasCommand}
            selectedId={state.selectedNodeId}
            search={state.search}
            showMinimap={showMinimap}
            fitKey={`${state.drawerOpen}:${state.controlsOpen}`}
            onSelect={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          />
        )}

        {ready && isProduct && (
          <ProductTreeCanvas
            graphNodes={graph.nodes}
            features={graph.features}
            command={canvasCommand}
            selectedFeatureId={state.selectedFeatureId}
            selectedNodeId={state.selectedNodeId}
            search={state.search}
            showMinimap={showMinimap}
            fitKey={`${state.drawerOpen}:${state.controlsOpen}`}
            onSelectFeature={(featureId) =>
              dispatch({ type: 'selectFeature', featureId })
            }
            onSelectNode={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          />
        )}

        {ready && isOnboarding && graph.onboarding !== null && (
          <OnboardingTreeCanvas
            graphNodes={graph.nodes}
            graphEdges={graph.edges}
            workflow={graph.onboarding}
            renderer={renderer.id}
            command={canvasCommand}
            selectedId={state.selectedNodeId}
            search={state.search}
            showMinimap={showMinimap}
            fitKey={`${state.drawerOpen}:${state.controlsOpen}`}
            onSelect={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          />
        )}

        {ready && (
          <span className="mock-statusline">
            {isTechnical
              ? 'tree layout · contains + imports'
              : isProduct
                ? `feature layout · ${graph.features.length} features`
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

export function WorkspaceShell() {
  const { mode, state } = useMock();
  const drawerOpen =
    state.drawerOpen &&
    (state.selectedNodeId !== null || state.selectedFeatureId !== null);

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

  return (
    <div className="mock-root" style={themeVariables(warmGraphiteTheme)}>
      <TopBar />
      <div className={`mock-body${drawerOpen ? ' mock-body-drawer' : ''}`}>
        <ViewRail />
        <ReactFlowProvider>
          <Workspace />
        </ReactFlowProvider>
        {drawerOpen &&
          (state.selectedNodeId !== null ? <NodeDrawer /> : <FeatureDrawer />)}
      </div>
      {mode === 'fixture' && <ControlPanel />}
    </div>
  );
}

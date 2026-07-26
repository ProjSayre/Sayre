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
    if (
      state.view === 'product' &&
      (semanticState.status === 'generating' || semanticState.status === 'failed')
    ) {
      return 'product-unavailable';
    }
    if (state.canvasData === 'empty' || graph.nodes.length === 0) return 'empty';
    return 'ready';
  })();

  const isTechnical = state.view === 'technical';
  const ready = status === 'ready';
  const visibleNodeCount = graph.nodes.length;
  const renderer = rendererFor(state.view, visibleNodeCount);
  const scopeLabel =
    state.selectedNodeId !== null
      ? 'selected node'
      : repository === null
        ? 'no repository'
        : repository.name;

  return (
    <main className="mock-main">
      <CanvasToolbar
        title={isTechnical ? 'Technical Tree' : 'Product Tree'}
        visibleNodeCount={ready ? visibleNodeCount : 0}
        edgeCount={ready && isTechnical ? graph.edges.length : null}
        renderer={renderer}
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

        {ready &&
          (isTechnical ? (
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
          ) : (
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
          ))}

        {ready && (
          <span className="mock-statusline">
            {isTechnical
              ? 'tree layout · contains + imports'
              : `feature layout · ${graph.features.length} features`}{' '}
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

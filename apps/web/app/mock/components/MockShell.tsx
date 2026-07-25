'use client';

import { useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { FEATURES, GRAPH_EDGES, GRAPH_NODES } from '../fixtures';
import { useMock } from '../state';
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
} from './CanvasStates';
import { CanvasToolbar } from './CanvasToolbar';
import { ControlPanel } from './ControlPanel';
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
  | 'product-unavailable'
  | 'ready';

const PRODUCT_FILE_COUNT = new Set(FEATURES.flatMap((feature) => feature.fileIds))
  .size;

function Workspace() {
  const {
    state,
    dispatch,
    repository,
    authorizedForRepository,
    readiness,
    semanticState,
  } = useMock();
  const [showMinimap, setShowMinimap] = useState(true);

  const status: CanvasStatus = ((): CanvasStatus => {
    if (repository === null) return 'no-repository';
    if (!authorizedForRepository) return 'forbidden';
    if (readiness === 'registered') return 'preparing';
    if (state.canvasData === 'loading') return 'loading';
    if (state.canvasData === 'empty') return 'empty';
    if (
      state.view === 'product' &&
      (semanticState.status === 'generating' || semanticState.status === 'failed')
    ) {
      return 'product-unavailable';
    }
    return 'ready';
  })();

  const isTechnical = state.view === 'technical';
  const ready = status === 'ready';
  const visibleNodeCount = isTechnical ? GRAPH_NODES.length : PRODUCT_FILE_COUNT;
  const scopeLabel =
    state.selectedNodeId !== null
      ? 'selected node'
      : repository === null
        ? 'no repository'
        : `${repository.owner}/${repository.name}`;

  return (
    <main className="mock-main">
      <CanvasToolbar
        title={isTechnical ? 'Technical Tree' : 'Product Tree'}
        visibleNodeCount={ready ? visibleNodeCount : 0}
        edgeCount={ready && isTechnical ? GRAPH_EDGES.length : null}
        interactive={ready}
        showMinimap={showMinimap}
        onToggleMinimap={() => setShowMinimap((value) => !value)}
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
          <PreparingState
            repositoryLabel={`${repository.owner}/${repository.name}`}
          />
        )}
        {status === 'forbidden' && <ForbiddenState />}
        {status === 'loading' && <LoadingState />}
        {status === 'empty' && <EmptyGraphState />}
        {status === 'product-unavailable' && (
          <ProductUnavailableState
            reason={semanticState.status === 'failed' ? 'failed' : 'generating'}
          />
        )}

        {ready &&
          (isTechnical ? (
            <TechnicalTreeCanvas
              selectedId={state.selectedNodeId}
              search={state.search}
              showMinimap={showMinimap}
              fitKey={`${state.drawerOpen}:${state.controlsOpen}`}
              onSelect={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
            />
          ) : (
            <ProductTreeCanvas
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
              : `feature layout · ${FEATURES.length} features`}{' '}
            · showing only nodes you are authorized to see
          </span>
        )}
      </div>

      <AskSayreDock scopeLabel={scopeLabel} />

      <SettingsPanel />
    </main>
  );
}

export function MockShell() {
  const { state } = useMock();
  const drawerOpen =
    state.drawerOpen &&
    (state.selectedNodeId !== null || state.selectedFeatureId !== null);

  return (
    <div className="mock-root">
      <TopBar />
      <div className={`mock-body${drawerOpen ? ' mock-body-drawer' : ''}`}>
        <ViewRail />
        <ReactFlowProvider>
          <Workspace />
        </ReactFlowProvider>
        {drawerOpen &&
          (state.selectedNodeId !== null ? <NodeDrawer /> : <FeatureDrawer />)}
      </div>
      <GlobalStates />
      <ControlPanel />
    </div>
  );
}

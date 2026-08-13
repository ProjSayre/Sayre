'use client';

import { useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useWorkspaceFixture, useWorkspaceNavigation, useWorkspaceQueries, useWorkspaceSelection, useWorkspaceSession } from '../state';
import type { CanvasCommand, CanvasCommandType } from '../rendererRegistry';
import { workspaceThemeVariables } from '../theme/workspaceTheme';
import { useWorkspacePack } from '../packs/WorkspacePackProvider';
import { defaultWorkspacePack } from '../packs/builtins';
import { SettingsPanel } from '../settings/SettingsPanel';
import {
  EmptyGraphState,
  ForbiddenState,
  ImportingRepositoriesState,
  LoadingState,
  NoRepositoryState,
  PreparingState,
  ProductUnavailableState,
  UnavailableState,
} from '../components/CanvasStates';
import { CanvasToolbar } from '../components/CanvasToolbar';
import { ControlPanel } from '../../mock/components/ControlPanel';
import { GlobalStates } from '../components/GlobalStates';
import { StatusBanner } from '../components/StatusBanner';
import { TopBar } from '../components/TopBar';
import { ViewRail } from '../components/ViewRail';
import { useWorkspaceViewRuntime } from './WorkspaceViewRuntime';

type CanvasStatus =
  | 'no-repository'
  | 'importing'
  | 'forbidden'
  | 'preparing'
  | 'loading'
  | 'empty'
  | 'unavailable'
  | 'product-unavailable'
  | 'ready';

function Workspace() {
  const session = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  const { semanticState, graph, graphStatus, graphErrorStatus } = useWorkspaceQueries();
  const fixture = useWorkspaceFixture();
  const canvasData = fixture?.state.canvasData ?? 'normal';
  const view = useWorkspaceViewRuntime();
  const [showMinimap, setShowMinimap] = useState(true);
  const [canvasCommand, setCanvasCommand] = useState<CanvasCommand | null>(null);

  const status: CanvasStatus = (() => {
    // W7-01 (AC-16): while no repository is selectable yet, a sync in flight reads as
    // "partially imported" rather than the misleading "No repository has been connected".
    if (session.repository === null && (session.sync.status === 'importing' || session.sync.status === 'stalled')) {
      return 'importing';
    }
    if (session.repository === null) return 'no-repository';
    if (!session.authorizedForRepository) return 'forbidden';
    if (session.readiness === 'registered') return 'preparing';
    if (canvasData === 'unavailable') return 'unavailable';
    if (canvasData === 'loading' || graphStatus === 'idle' || graphStatus === 'loading') return 'loading';
    if (graphStatus === 'error') return graphErrorStatus === 403 ? 'forbidden' : 'unavailable';
    if (view.id === 'onboarding' && graph.onboarding === null) return 'unavailable';
    if (view.id === 'product' && (semanticState.status === 'generating' || semanticState.status === 'failed')) {
      return 'product-unavailable';
    }
    if (canvasData === 'empty' || graph.nodes.length === 0) return 'empty';
    return 'ready';
  })();
  const ready = status === 'ready';
  const graphRootLabel = session.repository === null ? '/' : `${session.repository.name.split('/').pop() ?? session.repository.name}/`;
  const fitKey = `${selection.inspectorOpen}:${navigation.controlsOpen}:${navigation.fileTreeOpen}`;
  const commandCanvas = (type: CanvasCommandType): void => {
    setCanvasCommand((current) => ({ id: (current?.id ?? 0) + 1, type }));
  };

  return (
    <main className="mock-main">
      <CanvasToolbar
        title={view.title}
        visibleNodeCount={ready ? view.visibleNodeCount : 0}
        countLabel={ready ? view.countLabel : undefined}
        edgeCount={ready && view.id !== 'product' ? view.visibleEdgeCount : null}
        renderer={view.renderer}
        coverageSummary={ready ? view.coverageSummary : null}
        technicalExpansion={view.technicalExpansion ?? null}
        interactive={ready}
        showMinimap={showMinimap}
        onToggleMinimap={() => setShowMinimap((value) => !value)}
        onCommand={commandCanvas}
      />

      {session.repository !== null && session.authorizedForRepository && <StatusBanner />}
      {session.repository !== null && session.authorizedForRepository && session.sync.status !== 'idle' && (
        <ImportingRepositoriesState sync={session.sync} variant="chip" />
      )}

      <div className="mock-canvas" ref={view.canvasRef}>
        {status === 'importing' && <ImportingRepositoriesState sync={session.sync} variant="canvas" />}
        {status === 'no-repository' && <NoRepositoryState reason={session.access === 'no-repositories' ? 'none' : 'restricted'} />}
        {status === 'preparing' && session.repository !== null && <PreparingState repositoryLabel={session.repository.name} />}
        {status === 'forbidden' && <ForbiddenState />}
        {status === 'loading' && <LoadingState label={view.loadingLabel} />}
        {status === 'empty' && <EmptyGraphState />}
        {status === 'unavailable' && <UnavailableState />}
        {status === 'product-unavailable' && (
          <ProductUnavailableState reason={semanticState.status === 'failed' ? 'failed' : 'generating'} />
        )}
        {ready && view.renderCanvas({ command: canvasCommand, showMinimap, fitKey, graphRootLabel })}
        {ready && <span className="mock-statusline">{view.statusLine}</span>}
      </div>

      <SettingsPanel />
    </main>
  );
}

function WorkspaceBody() {
  return (
    <div className="mock-body">
      <ViewRail />
      <ReactFlowProvider>
        <Workspace />
      </ReactFlowProvider>
    </div>
  );
}

export function LegacyWorkspaceView() {
  const session = useWorkspaceSession();
  const globallyBlocked = session.session !== 'authenticated' || session.backend === 'unavailable' || session.access === 'forbidden';
  const { experience } = useWorkspacePack();
  const theme = globallyBlocked ? defaultWorkspacePack.pack.theme : experience.theme;
  const rootProps = {
    style: workspaceThemeVariables(theme),
    'data-workspace-density': theme.density,
    'data-workspace-radius': theme.radius,
  } as const;

  if (globallyBlocked) {
    return (
      <div className="mock-root" {...rootProps}>
        <GlobalStates />
        {session.mode === 'fixture' && <ControlPanel />}
      </div>
    );
  }

  return (
    <div className="mock-root" {...rootProps}>
      <TopBar />
      <WorkspaceBody />
      {session.mode === 'fixture' && <ControlPanel />}
    </div>
  );
}

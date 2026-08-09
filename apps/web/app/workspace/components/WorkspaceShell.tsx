'use client';

import { Component, useEffect, useLayoutEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { resolveWorkspaceExperience, type WorkspacePackRef } from '../../../../../packages/workspace-packs/src/runtime';
import { LayoutEditMode } from '../editor/LayoutEditMode';
import { WorkspaceEditorProvider, useWorkspaceEditor } from '../editor/WorkspaceEditorProvider';
import { WorkspacePackProvider } from '../packs/WorkspacePackProvider';
import { useWorkspacePack } from '../packs/WorkspacePackProvider';
import { workspaceComponentCatalog, workspaceComponentKey } from '../packs/componentCatalog';
import { WorkspaceLayout } from '../layout/WorkspaceLayout';
import { useWorkspaceNavigation, useWorkspaceQueries, useWorkspaceSelection, useWorkspaceSession } from '../state';
import { LegacyWorkspaceView } from '../views/LegacyWorkspaceView';
import { OnboardingWorkspaceView } from '../views/OnboardingWorkspaceView';
import { ProductWorkspaceView } from '../views/ProductWorkspaceView';
import { TechnicalWorkspaceView } from '../views/TechnicalWorkspaceView';
import { TechnicalExpansionProvider } from '../technicalExpansionState';
import { workspaceThemeVariables } from '../theme/workspaceTheme';
import type { ViewId } from '../types';
import { defaultWorkspacePack } from '../packs/builtins';
import { workspaceComponentCatalog as workspaceContractCatalog } from '../packs/runtimeCatalog';
import { SystemRecoveryMenu } from './SystemRecoveryMenu';

export class WorkspaceCatalogErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The recovery surface remains mounted outside this boundary.
  }

  render() {
    if (this.state.failed) {
      return <main role="alert">This workspace component failed. Use recovery controls to restore the default experience.</main>;
    }
    return this.props.children;
  }
}

function ResolvedWorkspaceContent({ initialViewPinned }: { initialViewPinned: boolean }) {
  const { graph, graphStatus } = useWorkspaceQueries();
  const session = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  const pack = useWorkspacePack();
  const editor = useWorkspaceEditor();
  const { interruptForSystemState } = editor;
  const experience = editor.editing && editor.previewPack !== null
    ? resolveWorkspaceExperience({
        safetyDefaults: defaultWorkspacePack.pack,
        selectedPack: editor.previewPack,
        organizationOverride: null,
        userOverride: null,
        userPreferences: null,
        catalog: workspaceContractCatalog,
        viewportClass: pack.viewportClass,
        role: session.role,
      })
    : pack.experience;
  const lastPack = useRef<string | null>(null);
  const defaultView = experience.views.find((view) => view.id === experience.defaultViewId && view.available)
    ?? experience.views.find((view) => view.available)!;
  const selectedView = experience.views.find((view) => view.id === navigation.viewId && view.available) ?? defaultView;
  const packKey = `${pack.activePackRef.id}@${pack.activePackRef.version}`;
  const blocked = session.session !== 'authenticated'
    || session.backend === 'unavailable'
    || session.access === 'forbidden'
    || session.repository === null
    || !session.authorizedForRepository;
  const blockAnnouncement = session.session !== 'authenticated'
    ? 'Your session changed. Layout editing and the active move were cancelled.'
    : session.backend === 'unavailable'
      ? 'The workspace service became unavailable. Layout editing and the active move were cancelled.'
      : session.access === 'forbidden'
        ? 'Organization access changed. Layout editing and the active move were cancelled.'
        : 'Repository access changed. Layout editing and the active move were cancelled.';
  const requestedView = useRef<string | null>(initialViewPinned ? navigation.viewId : null);
  const reportedViewRecovery = useRef<string | null>(null);

  useEffect(() => {
    const changed = lastPack.current !== packKey;
    const nextView = changed && !initialViewPinned ? defaultView : selectedView;
    if (navigation.viewId !== nextView.id) navigation.selectView(nextView.id as ViewId);
    lastPack.current = packKey;
  }, [defaultView, initialViewPinned, navigation, packKey, selectedView]);

  useEffect(() => {
    const requested = requestedView.current;
    if (requested === null || requested === selectedView.id) return;
    const recoveryKey = `${packKey}:${requested}`;
    if (reportedViewRecovery.current === recoveryKey) return;
    reportedViewRecovery.current = recoveryKey;
    pack.reportRecovery(`Requested view "${requested}" is unavailable in this Workspace Pack. ${selectedView.label} is active instead.`);
  }, [pack, packKey, selectedView]);

  useLayoutEffect(() => {
    if (blocked && editor.editing) interruptForSystemState(blockAnnouncement);
  }, [blockAnnouncement, blocked, editor.editing, interruptForSystemState]);

  const recovery = <SystemRecoveryMenu />;
  if (blocked) {
    const legacyView = <LegacyWorkspaceView />;
    const blockedContent = session.session !== 'authenticated' || session.backend === 'unavailable' || session.access === 'forbidden'
      ? legacyView
      : selectedView.id === 'product'
        ? <ProductWorkspaceView>{legacyView}</ProductWorkspaceView>
        : selectedView.id === 'onboarding'
          ? <OnboardingWorkspaceView>{legacyView}</OnboardingWorkspaceView>
          : <TechnicalWorkspaceView>{legacyView}</TechnicalWorkspaceView>;
    return (
      <div
        className="workspace-product-frame"
        data-viewport-preview={pack.viewportPreview ?? undefined}
        data-workspace-recovery-actions="switch to default; reset layout; edit workspace layout; workspace pack settings"
      >
        {recovery}
        <div className="workspace-product-frame__content">
          <TechnicalExpansionProvider scopeKey="system-state" nodes={null}>
            <LayoutEditMode systemBlocked>
              <WorkspaceCatalogErrorBoundary key={packKey}>
                {blockedContent}
              </WorkspaceCatalogErrorBoundary>
            </LayoutEditMode>
          </TechnicalExpansionProvider>
        </div>
      </div>
    );
  }

  const scopeKey = session.scope === null ? 'no-repository' : `${session.scope.repositoryId}:${session.scope.refName}`;
  const renderRegion = (regionId: string) => {
    const region = experience.layout.regions.find((item) => item.id === regionId);
    if (region === undefined) return { content: null, present: false };
    const definition = workspaceComponentCatalog.components.get(workspaceComponentKey(region.component));
    if (definition === undefined) throw new Error(`Missing trusted workspace component: ${workspaceComponentKey(region.component)}`);
    const config = definition.parseProps(region.component.props);
    const CatalogComponent = definition.Component;
    const runtimeState = {
      viewId: selectedView.id,
      fileTreeOpen: navigation.fileTreeOpen,
      inspectorOpen: selection.inspectorOpen,
      settingsOpen: navigation.settingsSection !== null,
      selectedNodeId: selection.selectedNodeId,
      selectedFeatureId: selection.selectedFeatureId,
    };
    return {
      content: <CatalogComponent config={config} region={region} view={selectedView} />,
      present: definition.isPresent?.(runtimeState) ?? true,
    };
  };
  const labelRegion = (regionId: string) => {
    const region = experience.layout.regions.find((item) => item.id === regionId);
    return region === undefined
      ? regionId
      : workspaceComponentCatalog.components.get(workspaceComponentKey(region.component))?.landmarkLabel ?? regionId;
  };

  return (
    <div
      className="workspace-product-frame"
      data-viewport-preview={pack.viewportPreview ?? undefined}
      data-workspace-recovery-actions="switch to default; reset layout; edit workspace layout; workspace pack settings"
      style={workspaceThemeVariables(experience.theme)}
    >
      {recovery}
      <div className="workspace-product-frame__content">
        <TechnicalExpansionProvider
          scopeKey={scopeKey}
          nodes={navigation.viewId === 'technical' && graphStatus === 'ready' ? graph.nodes : null}
        >
          <LayoutEditMode systemBlocked={false}>
            <WorkspaceCatalogErrorBoundary key={packKey}>
              <WorkspaceLayout
                layout={experience.layout}
                viewId={selectedView.id}
                renderRegion={renderRegion}
                labelRegion={labelRegion}
                onResize={pack.setRegionSize}
                onCollapse={(regionId) => pack.setRegionCollapsed(regionId, true)}
                onExpand={(regionId) => pack.setRegionCollapsed(regionId, false)}
              />
            </WorkspaceCatalogErrorBoundary>
          </LayoutEditMode>
        </TechnicalExpansionProvider>
      </div>
    </div>
  );
}

export function WorkspaceShell({
  initialPackRef,
  initialPackRequest = null,
  initialViewPinned = false,
}: {
  initialPackRef?: WorkspacePackRef;
  initialPackRequest?: string | null;
  initialViewPinned?: boolean;
}) {
  const { role } = useWorkspaceSession();
  return (
    <WorkspacePackProvider role={role} initialPackRef={initialPackRef} initialPackRequest={initialPackRequest}>
      <WorkspaceEditorProvider>
        <ResolvedWorkspaceContent initialViewPinned={initialViewPinned} />
      </WorkspaceEditorProvider>
    </WorkspacePackProvider>
  );
}

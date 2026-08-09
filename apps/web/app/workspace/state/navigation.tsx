'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { WorkspaceViewId } from '../../../../../packages/workspace-packs/src/runtime';
import type { SettingsSection, ViewId } from '../types';
import { useWorkspaceSession } from './session';
import { useWorkspaceStore } from './store';

export interface WorkspaceNavigationContextValue {
  repositoryId: string | null; refName: string | null; viewId: WorkspaceViewId; settingsSection: SettingsSection | null;
  controlsOpen: boolean; fileTreeOpen: boolean; search: string;
  selectRepository(repositoryId: string): void; selectRef(refName: string): void; selectView(viewId: WorkspaceViewId): void;
  openSettings(section: string): void; closeSettings(): void; setControlsOpen(open: boolean): void;
  setFileTreeOpen(open: boolean): void; toggleTechnicalExplorer(): void; setSearch(search: string): void;
}

const WorkspaceNavigationContext = createContext<WorkspaceNavigationContextValue | null>(null);

export function WorkspaceNavigationProvider({ children }: { children: ReactNode }) {
  const { state, dispatch, source } = useWorkspaceStore();
  const session = useWorkspaceSession();

  useEffect(() => {
    if (source.id !== 'live' || session.repository === null || session.scope === null) return;
    const params = new URLSearchParams(window.location.search);
    params.set('repoId', session.repository.id);
    params.set('refName', session.scope.refName);
    params.set('view', state.view);
    if (state.settingsSection === null) params.delete('settings'); else params.set('settings', state.settingsSection);
    if (state.selectedNodeId === null) params.delete('nodeId'); else params.set('nodeId', state.selectedNodeId);
    if (state.selectedFeatureId === null) params.delete('featureId'); else params.set('featureId', state.selectedFeatureId);
    window.history.replaceState(null, '', `/?${params.toString()}`);
  }, [session.repository, session.scope, source.id, state.selectedFeatureId, state.selectedNodeId, state.settingsSection, state.view]);

  const value = useMemo<WorkspaceNavigationContextValue>(() => ({
    repositoryId: state.repositoryId,
    refName: state.refName,
    viewId: state.view,
    settingsSection: state.settingsSection,
    controlsOpen: state.controlsOpen,
    fileTreeOpen: state.fileTreeOpen,
    search: state.search,
    selectRepository: (repositoryId: string) => {
      const repository = session.repositories.find((item) => item.id === repositoryId);
      dispatch({ type: 'patch', patch: {
        repositoryId,
        refName: repository?.currentRef ?? (repository?.defaultBranch ? `refs/heads/${repository.defaultBranch}` : null),
        selectedNodeId: null,
        selectedFeatureId: null,
        returnFeatureId: null,
        drawerOpen: false,
      } });
    },
    selectRef: (refName: string) => dispatch({ type: 'patch', patch: { refName, selectedNodeId: null, selectedFeatureId: null, returnFeatureId: null, drawerOpen: false } }),
    selectView: (viewId: WorkspaceViewId) => dispatch({
      type: 'patch',
      patch: viewId === 'technical'
        ? { view: viewId as ViewId, selectedFeatureId: null, drawerOpen: state.selectedNodeId !== null && state.drawerOpen, search: '' }
        : { view: viewId as ViewId, selectedNodeId: null, selectedFeatureId: null, returnFeatureId: null, drawerOpen: false, search: '' },
    }),
    openSettings: (section: string) => dispatch({ type: 'patch', patch: { settingsSection: section as SettingsSection } }),
    closeSettings: () => dispatch({ type: 'patch', patch: { settingsSection: null } }),
    setControlsOpen: (controlsOpen: boolean) => dispatch({ type: 'patch', patch: { controlsOpen } }),
    setFileTreeOpen: (fileTreeOpen: boolean) => dispatch({ type: 'patch', patch: { fileTreeOpen } }),
    toggleTechnicalExplorer: () => dispatch({
      type: 'patch',
      patch: state.view === 'technical'
        ? { fileTreeOpen: !state.fileTreeOpen }
        : {
            view: 'technical',
            fileTreeOpen: true,
            selectedFeatureId: null,
            returnFeatureId: null,
            drawerOpen: state.selectedNodeId !== null && state.drawerOpen,
            search: '',
          },
    }),
    setSearch: (search: string) => dispatch({ type: 'patch', patch: { search } }),
  }), [dispatch, session.repositories, state.controlsOpen, state.drawerOpen, state.fileTreeOpen, state.refName, state.repositoryId, state.search, state.selectedNodeId, state.settingsSection, state.view]);
  return <WorkspaceNavigationContext.Provider value={value}>{children}</WorkspaceNavigationContext.Provider>;
}

export function useWorkspaceNavigation(): WorkspaceNavigationContextValue {
  const value = useContext(WorkspaceNavigationContext);
  if (value === null) throw new Error('useWorkspaceNavigation must be used inside WorkspaceNavigationProvider.');
  return value;
}

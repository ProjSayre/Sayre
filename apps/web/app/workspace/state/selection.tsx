'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useWorkspaceSession } from './session';
import { useWorkspaceStore } from './store';

export interface WorkspaceSelectionContextValue {
  selectedNodeId: string | null; selectedFeatureId: string | null; returnFeatureId: string | null; inspectorOpen: boolean;
  selectNode(nodeId: string): void; selectFeature(featureId: string): void; clearSelection(): void;
  openNodeInTechnicalView(nodeId: string): void; closeInspector(): void; returnToFeature(): void;
}

const WorkspaceSelectionContext = createContext<WorkspaceSelectionContextValue | null>(null);

export function WorkspaceSelectionProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useWorkspaceStore();
  const { scope } = useWorkspaceSession();
  const previousScopeKey = useRef<string | null>(null);

  useEffect(() => {
    if (scope === null) return;
    const scopeKey = `${scope.repositoryId}:${scope.refName}`;
    const previous = previousScopeKey.current;
    previousScopeKey.current = scopeKey;
    if (previous === null || previous === scopeKey) return;
    dispatch({ type: 'clearSelection' });
  }, [dispatch, scope]);

  const value = useMemo<WorkspaceSelectionContextValue>(() => ({
    selectedNodeId: state.selectedNodeId,
    selectedFeatureId: state.selectedFeatureId,
    returnFeatureId: state.returnFeatureId,
    inspectorOpen: state.drawerOpen,
    selectNode: (nodeId: string) => dispatch({ type: 'selectNode', nodeId }),
    selectFeature: (featureId: string) => dispatch({ type: 'selectFeature', featureId }),
    openNodeInTechnicalView: (nodeId: string) => dispatch({ type: 'openTechnicalNode', nodeId }),
    clearSelection: () => dispatch({ type: 'clearSelection' }),
    closeInspector: () => dispatch({ type: 'closeDrawer' }),
    returnToFeature: () => {
      if (state.returnFeatureId !== null) dispatch({ type: 'selectFeature', featureId: state.returnFeatureId });
    },
  }), [dispatch, state.drawerOpen, state.returnFeatureId, state.selectedFeatureId, state.selectedNodeId]);
  return <WorkspaceSelectionContext.Provider value={value}>{children}</WorkspaceSelectionContext.Provider>;
}

export function useWorkspaceSelection(): WorkspaceSelectionContextValue {
  const value = useContext(WorkspaceSelectionContext);
  if (value === null) throw new Error('useWorkspaceSelection must be used inside WorkspaceSelectionProvider.');
  return value;
}

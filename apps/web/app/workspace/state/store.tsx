'use client';

import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import { DEFAULT_REPOSITORY_ID } from '../../mock/fixtures';
import { liveWorkspaceDataSource, type WorkspaceDataSource } from '../dataSource';
import type {
  BackendState,
  InstallationOutcome,
  RealtimeStatus,
  RepositoryAccess,
  RepositoryReadiness,
  Role,
  SemanticStatus,
  SessionState,
  SettingsSection,
  ViewId,
} from '../types';
import type { WorkspacePackRef } from '../../../../../packages/workspace-packs/src/runtime';

export interface WorkspaceState {
  session: SessionState;
  role: Role;
  access: RepositoryAccess;
  backend: BackendState;
  semantic: SemanticStatus;
  realtime: RealtimeStatus;
  installation: InstallationOutcome;
  readinessOverride: RepositoryReadiness | null;
  canvasData: 'normal' | 'loading' | 'empty' | 'unavailable';
  repositoryId: string | null;
  refName: string | null;
  view: ViewId;
  selectedNodeId: string | null;
  selectedFeatureId: string | null;
  returnFeatureId: string | null;
  drawerOpen: boolean;
  settingsSection: SettingsSection | null;
  controlsOpen: boolean;
  fileTreeOpen: boolean;
  search: string;
  agentSkillConflict: boolean;
}

export type MockState = WorkspaceState;

export const FIXTURE_INITIAL_STATE: WorkspaceState = {
  session: 'authenticated',
  role: 'admin',
  access: 'authorized',
  backend: 'available',
  semantic: 'ready',
  realtime: 'connected',
  installation: 'installed',
  readinessOverride: null,
  canvasData: 'normal',
  repositoryId: DEFAULT_REPOSITORY_ID,
  refName: 'refs/heads/main',
  view: 'technical',
  selectedNodeId: null,
  selectedFeatureId: null,
  returnFeatureId: null,
  drawerOpen: false,
  settingsSection: null,
  controlsOpen: false,
  fileTreeOpen: true,
  search: '',
  agentSkillConflict: false,
};

export type WorkspaceAction =
  | { type: 'patch'; patch: Partial<WorkspaceState> }
  | { type: 'selectNode'; nodeId: string }
  | { type: 'selectFeature'; featureId: string }
  | { type: 'openTechnicalNode'; nodeId: string }
  | { type: 'clearSelection' }
  | { type: 'closeDrawer' }
  | { type: 'reset'; state?: WorkspaceState };

export type MockAction = WorkspaceAction;

function reducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'selectNode':
      return {
        ...state,
        selectedNodeId: action.nodeId,
        returnFeatureId: state.view === 'product' ? state.selectedFeatureId : state.returnFeatureId,
        selectedFeatureId: null,
        drawerOpen: true,
      };
    case 'selectFeature':
      return { ...state, view: 'product', selectedFeatureId: action.featureId, selectedNodeId: null, returnFeatureId: null, drawerOpen: true };
    case 'openTechnicalNode':
      return {
        ...state,
        view: 'technical',
        selectedNodeId: action.nodeId,
        selectedFeatureId: null,
        returnFeatureId: state.selectedFeatureId ?? state.returnFeatureId,
        drawerOpen: true,
        fileTreeOpen: true,
        search: '',
      };
    case 'clearSelection':
      return { ...state, selectedNodeId: null, selectedFeatureId: null, returnFeatureId: null, drawerOpen: false };
    case 'closeDrawer':
      return { ...state, drawerOpen: false };
    case 'reset':
      return action.state ?? FIXTURE_INITIAL_STATE;
    default:
      return state;
  }
}

function initialState(options: {
  mode: WorkspaceDataSource['id'];
  repositoryId?: string | null;
  refName?: string | null;
  view?: ViewId;
  settingsSection?: SettingsSection | null;
  selectedNodeId?: string | null;
  selectedFeatureId?: string | null;
}): WorkspaceState {
  if (options.mode === 'fixture') {
    const view = options.view ?? FIXTURE_INITIAL_STATE.view;
    const selectedFeatureId = view === 'product' ? options.selectedFeatureId ?? null : null;
    const selectedNodeId = selectedFeatureId === null ? options.selectedNodeId ?? null : null;
    return {
      ...FIXTURE_INITIAL_STATE,
      repositoryId: options.repositoryId ?? FIXTURE_INITIAL_STATE.repositoryId,
      refName: options.refName ?? FIXTURE_INITIAL_STATE.refName,
      view,
      settingsSection: options.settingsSection ?? FIXTURE_INITIAL_STATE.settingsSection,
      selectedNodeId,
      selectedFeatureId,
      drawerOpen: selectedNodeId !== null || selectedFeatureId !== null,
    };
  }
  const selectedFeatureId = options.view === 'product' ? options.selectedFeatureId ?? null : null;
  const selectedNodeId = selectedFeatureId === null ? options.selectedNodeId ?? null : null;
  return {
    ...FIXTURE_INITIAL_STATE,
    role: 'member',
    realtime: 'not-connected',
    installation: 'not-installed',
    repositoryId: options.repositoryId ?? null,
    refName: options.refName ?? null,
    view: options.view ?? 'technical',
    settingsSection: options.settingsSection ?? null,
    selectedNodeId,
    selectedFeatureId,
    returnFeatureId: null,
    drawerOpen: selectedNodeId !== null || selectedFeatureId !== null,
  };
}

export interface WorkspaceProviderProps {
  children: ReactNode;
  source?: WorkspaceDataSource;
  gatewayWsUrl?: string | null;
  allowLocalGatewayFallback?: boolean;
  initialRepositoryId?: string | null;
  initialRefName?: string | null;
  initialView?: ViewId;
  initialSettingsSection?: SettingsSection | null;
  initialNodeId?: string | null;
  initialFeatureId?: string | null;
  initialPackRef?: WorkspacePackRef | null;
}

export interface WorkspaceStoreValue {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  source: WorkspaceDataSource;
  gatewayWsUrl: string | null;
  allowLocalGatewayFallback: boolean;
}

const WorkspaceStoreContext = createContext<WorkspaceStoreValue | null>(null);

export function WorkspaceStateStoreProvider({
  children,
  source = liveWorkspaceDataSource,
  gatewayWsUrl = null,
  allowLocalGatewayFallback = false,
  initialRepositoryId,
  initialRefName,
  initialView,
  initialSettingsSection,
  initialNodeId,
  initialFeatureId,
}: WorkspaceProviderProps) {
  const initial = useMemo(() => initialState({
    mode: source.id,
    repositoryId: initialRepositoryId,
    refName: initialRefName,
    view: initialView,
    settingsSection: initialSettingsSection,
    selectedNodeId: initialNodeId,
    selectedFeatureId: initialFeatureId,
  }), [initialFeatureId, initialNodeId, initialRefName, initialRepositoryId, initialSettingsSection, initialView, source.id]);
  const [state, dispatch] = useReducer(reducer, initial);
  const value = useMemo(() => ({ state, dispatch, source, gatewayWsUrl, allowLocalGatewayFallback }), [allowLocalGatewayFallback, gatewayWsUrl, source, state]);
  return <WorkspaceStoreContext.Provider value={value}>{children}</WorkspaceStoreContext.Provider>;
}

export function useWorkspaceStore(): WorkspaceStoreValue {
  const value = useContext(WorkspaceStoreContext);
  if (value === null) throw new Error('Focused workspace providers require WorkspaceStateStoreProvider.');
  return value;
}

export function statusOf(error: unknown): number | null {
  return typeof error === 'object' && error !== null && 'status' in error
    && (typeof error.status === 'number' || error.status === null)
    ? error.status
    : null;
}

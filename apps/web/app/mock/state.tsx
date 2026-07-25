'use client';

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import { DEFAULT_REPOSITORY_ID, REPOSITORIES } from './fixtures';
import type {
  BackendState,
  InstallationOutcome,
  RealtimeStatus,
  Repository,
  RepositoryAccess,
  RepositoryReadiness,
  Role,
  SemanticState,
  SemanticStatus,
  SessionState,
  ViewId,
} from './types';

export interface MockState {
  /** Scenario dials — driven by the mock control panel. */
  session: SessionState;
  role: Role;
  access: RepositoryAccess;
  backend: BackendState;
  semantic: SemanticStatus;
  realtime: RealtimeStatus;
  installation: InstallationOutcome;
  readinessOverride: RepositoryReadiness | null;
  /** Forces the Technical Tree's own loading / empty states. */
  canvasData: 'normal' | 'loading' | 'empty';

  /** Ordinary UI state. */
  repositoryId: string;
  view: ViewId;
  selectedNodeId: string | null;
  selectedFeatureId: string | null;
  drawerOpen: boolean;
  settingsSection: 'github' | 'providers' | null;
  controlsOpen: boolean;
  search: string;
  /** Simulates another editor saving the same Agent/Skill MD mid-edit. */
  agentSkillConflict: boolean;
}

const INITIAL_STATE: MockState = {
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
  view: 'technical',
  selectedNodeId: null,
  selectedFeatureId: null,
  drawerOpen: false,
  settingsSection: null,
  controlsOpen: false,
  search: '',
  agentSkillConflict: false,
};

export type MockAction =
  | { type: 'patch'; patch: Partial<MockState> }
  | { type: 'selectNode'; nodeId: string }
  | { type: 'selectFeature'; featureId: string }
  | { type: 'closeDrawer' }
  | { type: 'reset' };

function reducer(state: MockState, action: MockAction): MockState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'selectNode':
      return {
        ...state,
        selectedNodeId: action.nodeId,
        selectedFeatureId: null,
        drawerOpen: true,
      };
    case 'selectFeature':
      return {
        ...state,
        selectedFeatureId: action.featureId,
        selectedNodeId: null,
        drawerOpen: true,
      };
    case 'closeDrawer':
      return { ...state, drawerOpen: false };
    case 'reset':
      return INITIAL_STATE;
    default:
      return state;
  }
}

interface MockContextValue {
  state: MockState;
  dispatch: Dispatch<MockAction>;
  /** Repositories the viewer is authorized to see, per the current scenario. */
  repositories: Repository[];
  repository: Repository | null;
  /**
   * False when the selected repository is outside the viewer's scope — the
   * deep-link case, where a shared URL names a repository they cannot read.
   */
  authorizedForRepository: boolean;
  readiness: RepositoryReadiness;
  semanticState: SemanticState;
  isAdmin: boolean;
}

const MockContext = createContext<MockContextValue | null>(null);

const SEMANTIC_REASONS: Record<SemanticStatus, string | null> = {
  generating: null,
  ready: null,
  degraded:
    'Semantic features are temporarily degraded. Repository structure remains available.',
  failed:
    'Product Tree generation did not complete. Repository structure remains available.',
};

/**
 * The server would never send unauthorized repositories to the client at all.
 * The mock models that by filtering here rather than hiding rows in the UI.
 */
function visibleRepositories(access: RepositoryAccess): Repository[] {
  if (access === 'no-repositories' || access === 'forbidden') return [];
  if (access === 'repository-restricted') {
    // A narrower grant that deliberately excludes the default selection, so the
    // deep-link-to-a-repository-you-cannot-read case is reachable.
    return REPOSITORIES.filter((repo) => repo.restricted !== true).slice(1);
  }
  return REPOSITORIES.filter((repo) => repo.restricted !== true);
}

export function MockProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const value = useMemo<MockContextValue>(() => {
    const repositories = visibleRepositories(state.access);
    const authorized = repositories.find((repo) => repo.id === state.repositoryId);
    // Fall back to the full catalogue so a repository the viewer cannot read
    // still resolves to a name — the canvas then refuses it explicitly instead
    // of silently swapping in a different repository.
    const repository =
      authorized ??
      REPOSITORIES.find((repo) => repo.id === state.repositoryId) ??
      repositories[0] ??
      null;
    const readiness: RepositoryReadiness =
      state.readinessOverride ?? repository?.readiness ?? 'registered';

    return {
      state,
      dispatch,
      repositories,
      repository,
      authorizedForRepository:
        repository === null ||
        repositories.some((repo) => repo.id === repository.id),
      readiness,
      semanticState: {
        status: state.semantic,
        reason: SEMANTIC_REASONS[state.semantic],
        updatedAt: '2026-07-25T14:12:00Z',
      },
      isAdmin: state.role === 'admin' || state.role === 'owner',
    };
  }, [state]);

  return <MockContext.Provider value={value}>{children}</MockContext.Provider>;
}

export function useMock(): MockContextValue {
  const value = useContext(MockContext);
  if (value === null) {
    throw new Error('useMock must be used inside <MockProvider>.');
  }
  return value;
}

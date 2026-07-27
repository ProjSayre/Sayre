'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import { DEFAULT_REPOSITORY_ID } from '../mock/fixtures';
import {
  fixtureWorkspaceDataSource,
  liveWorkspaceDataSource,
  type WorkspaceDataSource,
  type WorkspaceScope,
} from './dataSource';
import type {
  BackendState,
  InstallationOutcome,
  LoadStatus,
  NodeOverlay,
  RealtimeStatus,
  Repository,
  RepositoryAccess,
  RepositoryReadiness,
  Role,
  SemanticState,
  SemanticStatus,
  SessionState,
  SettingsSection,
  ViewId,
  WorkspaceGraph,
  AgentSkillVersion,
} from './types';
import { workspaceView } from './viewRegistry';
import { browserRealtimeUrl, parseGatewayMessage } from './realtime';
import type {
  GitHubIntegrationStatusResponse,
  McpClientKeyCreateRequest,
  McpClientKeyIssued,
  McpClientKeyView,
  McpKeySettingsResponse,
  ProviderPurpose,
  ProviderSettingsResponse,
  ProviderSettingsUpdateRequest,
  ProviderSettingView,
} from '@sayre/shared-types';
import type { OnboardingExecutionResponse } from '../lib/onboardingTree';
import { getStoredSessionToken } from '../lib/coreFetch';

export interface WorkspaceState {
  /** Scenario dials are exposed only by the fixture route. */
  session: SessionState;
  role: Role;
  access: RepositoryAccess;
  backend: BackendState;
  semantic: SemanticStatus;
  realtime: RealtimeStatus;
  installation: InstallationOutcome;
  readinessOverride: RepositoryReadiness | null;
  canvasData: 'normal' | 'loading' | 'empty';

  /** Ordinary shareable UI state. */
  repositoryId: string | null;
  refName: string | null;
  view: ViewId;
  selectedNodeId: string | null;
  selectedFeatureId: string | null;
  /** Feature context retained while its implementation is inspected. */
  returnFeatureId: string | null;
  drawerOpen: boolean;
  settingsSection: SettingsSection | null;
  controlsOpen: boolean;
  fileTreeOpen: boolean;
  search: string;
  /** Fixture-only optimistic-concurrency scenario. */
  agentSkillConflict: boolean;
}

export type MockState = WorkspaceState;

const FIXTURE_INITIAL_STATE: WorkspaceState = {
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
  | { type: 'closeDrawer' }
  | { type: 'reset'; state?: WorkspaceState };

export type MockAction = WorkspaceAction;

function reducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'selectNode':
      return {
        ...state,
        selectedNodeId: action.nodeId,
        returnFeatureId:
          state.view === 'product'
            ? state.selectedFeatureId
            : state.returnFeatureId,
        selectedFeatureId: null,
        drawerOpen: true,
      };
    case 'selectFeature':
      return {
        ...state,
        selectedFeatureId: action.featureId,
        selectedNodeId: null,
        returnFeatureId: null,
        drawerOpen: true,
      };
    case 'closeDrawer':
      return { ...state, drawerOpen: false };
    case 'reset':
      return action.state ?? FIXTURE_INITIAL_STATE;
    default:
      return state;
  }
}

interface WorkspaceContextValue {
  mode: WorkspaceDataSource['id'];
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  repositories: Repository[];
  repository: Repository | null;
  authorizedForRepository: boolean;
  readiness: RepositoryReadiness;
  scope: WorkspaceScope | null;
  graph: WorkspaceGraph;
  graphStatus: LoadStatus;
  graphErrorStatus: number | null;
  semanticState: SemanticState;
  nodeOverlay: NodeOverlay | null;
  overlayStatus: LoadStatus;
  isAdmin: boolean;
  reloadCatalog: () => void;
  reloadGraph: () => void;
  reloadOverlay: () => void;
  saveAgentSkillMd: (
    nodeId: string,
    content: string,
    expectedVersion: number,
  ) => Promise<AgentSkillVersion>;
  runOnboardingStep: (stepId: string) => Promise<OnboardingExecutionResponse>;
  loadProviderSettings: (signal: AbortSignal) => Promise<ProviderSettingsResponse>;
  saveProviderSetting: (
    purpose: ProviderPurpose,
    update: ProviderSettingsUpdateRequest,
  ) => Promise<ProviderSettingView>;
  loadMcpSettings: (signal: AbortSignal) => Promise<McpKeySettingsResponse>;
  issueMcpKey: (
    request: McpClientKeyCreateRequest,
  ) => Promise<McpClientKeyIssued>;
  revokeMcpKey: (keyId: string) => Promise<McpClientKeyView>;
  saveMcpRateLimit: (
    rateLimitPerMinute: number,
  ) => Promise<{ rateLimitPerMinute: number }>;
  loadGitHubIntegrationStatus: (
    signal: AbortSignal,
  ) => Promise<GitHubIntegrationStatusResponse>;
  githubInstallUrl: string;
  viewer: WorkspaceDataSource['viewer'];
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const EMPTY_GRAPH: WorkspaceGraph = {
  nodes: [],
  edges: [],
  features: [],
  onboarding: null,
  productCoverage: null,
};

const SEMANTIC_REASONS: Record<SemanticStatus, string | null> = {
  generating: null,
  ready: null,
  degraded:
    'Semantic features are temporarily degraded. Repository structure remains available.',
  failed:
    'Product Tree generation did not complete. Repository structure remains available.',
};

function statusOf(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (typeof error.status === 'number' || error.status === null)
  ) {
    return error.status;
  }
  return null;
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
    return {
      ...FIXTURE_INITIAL_STATE,
      settingsSection:
        options.settingsSection ?? FIXTURE_INITIAL_STATE.settingsSection,
    };
  }
  const selectedFeatureId =
    options.view === 'product' ? options.selectedFeatureId ?? null : null;
  const selectedNodeId =
    selectedFeatureId === null ? options.selectedNodeId ?? null : null;
  return {
    ...FIXTURE_INITIAL_STATE,
    // Fail closed until an admin-only capability probe succeeds. Core remains
    // authoritative on every write regardless of this presentation hint.
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

function visibleRepositories(
  mode: WorkspaceDataSource['id'],
  access: RepositoryAccess,
  catalog: Repository[],
): Repository[] {
  if (access === 'no-repositories' || access === 'forbidden') return [];
  if (mode === 'fixture' && access === 'repository-restricted') {
    return catalog.filter((repo) => repo.restricted !== true).slice(1);
  }
  return catalog.filter((repo) => repo.restricted !== true);
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
}

export function WorkspaceProvider({
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
  const initial = useMemo(
    () =>
      initialState({
        mode: source.id,
        repositoryId: initialRepositoryId,
        refName: initialRefName,
        view: initialView,
        settingsSection: initialSettingsSection,
        selectedNodeId: initialNodeId,
        selectedFeatureId: initialFeatureId,
      }),
    [
      initialRefName,
      initialRepositoryId,
      initialSettingsSection,
      initialFeatureId,
      initialNodeId,
      initialView,
      source.id,
    ],
  );
  const [state, dispatch] = useReducer(reducer, initial);
  const [catalog, setCatalog] = useState<Repository[]>([]);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [graphVersion, setGraphVersion] = useState(0);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const [graph, setGraph] = useState<WorkspaceGraph>(EMPTY_GRAPH);
  const [graphStatus, setGraphStatus] = useState<LoadStatus>('idle');
  const [graphErrorStatus, setGraphErrorStatus] = useState<number | null>(null);
  const [providerSemantic, setProviderSemantic] = useState<SemanticState>({
    status: 'generating',
    reasonCode: null,
    reason: null,
    updatedAt: null,
  });
  const [nodeOverlay, setNodeOverlay] = useState<NodeOverlay | null>(null);
  const [overlayStatus, setOverlayStatus] = useState<LoadStatus>('idle');

  const repositories = useMemo(
    () => visibleRepositories(source.id, state.access, catalog),
    [catalog, source.id, state.access],
  );
  const authorizedRepository =
    repositories.find((repository) => repository.id === state.repositoryId) ??
    null;
  const repository =
    authorizedRepository ??
    catalog.find((candidate) => candidate.id === state.repositoryId) ??
    repositories[0] ??
    null;
  const authorizedForRepository =
    repository === null ||
    repositories.some((candidate) => candidate.id === repository.id);
  const readiness =
    state.readinessOverride ?? repository?.readiness ?? 'registered';
  const refName =
    state.refName ??
    repository?.currentRef ??
    (repository?.defaultBranch
      ? `refs/heads/${repository.defaultBranch}`
      : null);
  const scope = useMemo<WorkspaceScope | null>(
    () =>
      repository !== null && refName !== null
        ? { repositoryId: repository.id, refName }
        : null,
    [refName, repository],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void source
      .repositories(controller.signal)
      .then((nextCatalog) => {
        if (!active) return;
        setCatalog(nextCatalog);
        dispatch({
          type: 'patch',
          patch: {
            backend: 'available',
            session: 'authenticated',
            access:
              source.id === 'live'
                ? nextCatalog.length === 0
                  ? 'no-repositories'
                  : 'authorized'
                : state.access,
            repositoryId:
              nextCatalog.some((item) => item.id === state.repositoryId)
                ? state.repositoryId
                : nextCatalog[0]?.id ?? null,
            refName:
              nextCatalog.some((item) => item.id === state.repositoryId)
                ? state.refName
                : nextCatalog[0]?.currentRef ??
                  (nextCatalog[0]?.defaultBranch
                    ? `refs/heads/${nextCatalog[0].defaultBranch}`
                    : null),
          },
        });
      })
      .catch((error: unknown) => {
        if (!active || (error as { name?: string }).name === 'AbortError') return;
        const status = statusOf(error);
        if (status === 401) {
          dispatch({
            type: 'patch',
            patch: {
              session:
                getStoredSessionToken() === null
                  ? 'signed-out'
                  : 'session-expired',
            },
          });
        } else if (status === 403) {
          dispatch({ type: 'patch', patch: { access: 'forbidden' } });
        } else {
          dispatch({ type: 'patch', patch: { backend: 'unavailable' } });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
    // Reloads deliberately use the currently selected id as a preference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogVersion, source]);

  useEffect(() => {
    if (source.id !== 'live' || state.session !== 'authenticated') {
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    void source
      .providerSettings(controller.signal)
      .then(() => {
        if (active) {
          dispatch({ type: 'patch', patch: { role: 'admin' } });
        }
      })
      .catch((error: unknown) => {
        if (!active || (error as { name?: string }).name === 'AbortError') return;
        const status = statusOf(error);
        if (status === 401) {
          dispatch({ type: 'patch', patch: { session: 'session-expired' } });
        } else {
          // 403 means an ordinary member. Other failures must not grant write
          // affordances merely because the capability could not be checked.
          dispatch({ type: 'patch', patch: { role: 'member' } });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [source, state.session]);

  const previousSelectionScopeKey = useRef<string | null>(null);
  useEffect(() => {
    if (scope === null) return;
    const scopeKey = `${scope.repositoryId}:${scope.refName}`;
    const previousScopeKey = previousSelectionScopeKey.current;
    previousSelectionScopeKey.current = scopeKey;
    // Preserve a server-validated deep link on the initial scope load. A real
    // repository/ref change clears the old selection.
    if (previousScopeKey === null || previousScopeKey === scopeKey) return;
    setNodeOverlay(null);
    setOverlayStatus('idle');
    dispatch({
      type: 'patch',
      patch: {
        selectedNodeId: null,
        selectedFeatureId: null,
        returnFeatureId: null,
        drawerOpen: false,
      },
    });
  }, [scope]);

  const selectionRef = useRef({
    nodeId: state.selectedNodeId,
    featureId: state.selectedFeatureId,
  });
  useEffect(() => {
    selectionRef.current = {
      nodeId: state.selectedNodeId,
      featureId: state.selectedFeatureId,
    };
  }, [state.selectedFeatureId, state.selectedNodeId]);

  useEffect(() => {
    if (
      scope === null ||
      !authorizedForRepository ||
      readiness === 'registered' ||
      !workspaceView(state.view).enabled
    ) {
      setGraph(EMPTY_GRAPH);
      setGraphStatus('idle');
      setGraphErrorStatus(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setGraphStatus('loading');
    setGraphErrorStatus(null);
    void workspaceView(state.view)
      .load(source, scope, controller.signal)
      .then((nextGraph) => {
        if (!active) return;
        setGraph(nextGraph);
        setGraphStatus('ready');
        const selected = selectionRef.current;
        if (
          (selected.nodeId !== null &&
            !nextGraph.nodes.some((node) => node.id === selected.nodeId)) ||
          (selected.featureId !== null &&
            !nextGraph.features.some(
              (feature) => feature.id === selected.featureId,
            ))
        ) {
          dispatch({ type: 'closeDrawer' });
        }
        dispatch({ type: 'patch', patch: { backend: 'available' } });
      })
      .catch((error: unknown) => {
        if (!active || (error as { name?: string }).name === 'AbortError') return;
        setGraph(EMPTY_GRAPH);
        setGraphStatus('error');
        const status = statusOf(error);
        setGraphErrorStatus(status);
        if (status === 401) {
          dispatch({ type: 'patch', patch: { session: 'session-expired' } });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    authorizedForRepository,
    graphVersion,
    readiness,
    scope,
    source,
    state.view,
  ]);

  useEffect(() => {
    if (scope === null || readiness === 'registered') {
      setProviderSemantic({
        status: 'generating',
        reasonCode: null,
        reason: null,
        updatedAt: null,
      });
      return;
    }
    let active = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const providerSurface =
      state.view === 'onboarding' ? 'onboarding' : 'product';

    const refresh = (): void => {
      controller = new AbortController();
      void source
        .providerState(scope, providerSurface, controller.signal)
        .then((providerState) => {
          if (!active) return;
          const status =
            providerState?.status ??
            (providerSurface === 'onboarding'
              ? graph.onboarding !== null
                ? 'ready'
                : 'generating'
              : graph.features.length > 0
                ? 'ready'
                : 'generating');
          setProviderSemantic({
            status,
            reasonCode: providerState?.reasonCode ?? null,
            reason: SEMANTIC_REASONS[status],
            updatedAt: providerState?.updatedAt ?? null,
          });
        })
        .catch((error: unknown) => {
          if (
            active &&
            (error as { name?: string }).name !== 'AbortError'
          ) {
            if (statusOf(error) === 401) {
              dispatch({
                type: 'patch',
                patch: { session: 'session-expired' },
              });
            }
            setProviderSemantic({
              status:
                providerSurface === 'onboarding'
                  ? graph.onboarding !== null
                    ? 'ready'
                    : 'generating'
                  : graph.features.length > 0
                    ? 'ready'
                    : 'generating',
              reasonCode: null,
              reason: null,
              updatedAt: null,
            });
          }
        })
        .finally(() => {
          if (active) timer = setTimeout(refresh, 5_000);
        });
    };

    refresh();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    graph.features.length,
    graph.onboarding,
    readiness,
    scope,
    source,
    state.view,
  ]);

  useEffect(() => {
    const nodeId = state.selectedNodeId;
    if (nodeId === null) {
      setNodeOverlay(null);
      setOverlayStatus('idle');
      return;
    }
    const controller = new AbortController();
    let active = true;
    setNodeOverlay(null);
    setOverlayStatus('loading');
    void source
      .nodeOverlay(nodeId, controller.signal)
      .then((nextOverlay) => {
        if (!active) return;
        setNodeOverlay(nextOverlay);
        setOverlayStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active || (error as { name?: string }).name === 'AbortError') return;
        if (statusOf(error) === 401) {
          dispatch({ type: 'patch', patch: { session: 'session-expired' } });
        }
        setOverlayStatus('error');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [overlayVersion, source, state.selectedNodeId]);

  useEffect(() => {
    if (source.id !== 'live' || repository === null || scope === null) return;
    const params = new URLSearchParams(window.location.search);
    params.set('repoId', repository.id);
    params.set('refName', scope.refName);
    params.set('view', state.view);
    if (state.settingsSection === null) {
      params.delete('settings');
    } else {
      params.set('settings', state.settingsSection);
    }
    if (state.selectedNodeId === null) {
      params.delete('nodeId');
    } else {
      params.set('nodeId', state.selectedNodeId);
    }
    if (state.selectedFeatureId === null) {
      params.delete('featureId');
    } else {
      params.set('featureId', state.selectedFeatureId);
    }
    window.history.replaceState(null, '', `/?${params.toString()}`);
  }, [
    repository,
    scope,
    source.id,
    state.selectedFeatureId,
    state.selectedNodeId,
    state.settingsSection,
    state.view,
  ]);

  const reloadCatalog = useCallback(
    () => setCatalogVersion((version) => version + 1),
    [],
  );
  useEffect(() => {
    if (
      source.id !== 'live' ||
      state.session !== 'authenticated' ||
      !catalog.some((repository) => repository.readiness === 'registered')
    ) {
      return undefined;
    }
    const timer = setTimeout(reloadCatalog, 2_500);
    return () => clearTimeout(timer);
  }, [catalog, reloadCatalog, source.id, state.session]);
  const reloadGraph = useCallback(
    () => setGraphVersion((version) => version + 1),
    [],
  );
  const reloadOverlay = useCallback(
    () => setOverlayVersion((version) => version + 1),
    [],
  );
  const saveAgentSkillMd = useCallback(
    async (nodeId: string, content: string, expectedVersion: number) => {
      if (source.id === 'fixture' && state.agentSkillConflict) {
        const conflict = new Error('Agent/Skill MD version conflict.');
        Object.assign(conflict, { status: 409 });
        throw conflict;
      }
      const saved = await source.saveAgentSkillMd(
        nodeId,
        content,
        expectedVersion,
      );
      setNodeOverlay((current) =>
        current?.nodeId === nodeId
          ? {
              ...current,
              agentSkillMd: saved,
              agentSkillHistory:
                current.agentSkillMd === null
                  ? current.agentSkillHistory
                  : [current.agentSkillMd, ...current.agentSkillHistory],
            }
          : current,
      );
      return saved;
    },
    [source, state.agentSkillConflict],
  );
  const runOnboardingStep = useCallback(
    (stepId: string) => {
      if (scope === null) {
        throw new Error('Select a repository before running an onboarding step.');
      }
      return source.runOnboardingStep(scope, stepId);
    },
    [scope, source],
  );

  useEffect(() => {
    if (source.id !== 'live' || repository === null) {
      if (source.id === 'live') {
        dispatch({ type: 'patch', patch: { realtime: 'not-connected' } });
      }
      return undefined;
    }

    const url = browserRealtimeUrl(
      window.location,
      gatewayWsUrl ?? undefined,
      allowLocalGatewayFallback,
    );
    if (url === null) {
      dispatch({ type: 'patch', patch: { realtime: 'not-connected' } });
      return undefined;
    }

    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const settleToConnected = (): void => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (active) {
          dispatch({ type: 'patch', patch: { realtime: 'connected' } });
        }
      }, 1_400);
    };

    const scheduleReconnect = (): void => {
      if (!active || reconnectTimer !== null) return;
      dispatch({ type: 'patch', patch: { realtime: 'reconnecting' } });
      const delay = Math.min(20_000, 750 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = (): void => {
      if (!active) return;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socket.addEventListener('open', () => {
        const sessionToken = getStoredSessionToken();
        if (sessionToken !== null) {
          socket?.send(JSON.stringify({ type: 'auth', token: sessionToken }));
        }
        // Development auto-auth and production first-frame auth both reply
        // with `ready`; no subscription is sent before that boundary.
        dispatch({ type: 'patch', patch: { realtime: 'reconnecting' } });
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const message = parseGatewayMessage(event.data);
        if (message === null) return;
        if (message.type === 'ready') {
          socket?.send(
            JSON.stringify({ type: 'subscribe', repoId: repository.id }),
          );
          return;
        }
        if (
          message.type === 'subscribed' &&
          message.repoId === repository.id
        ) {
          reconnectAttempt = 0;
          dispatch({ type: 'patch', patch: { realtime: 'connected' } });
          return;
        }
        if (
          (message.type === 'graph.delta' ||
            message.type === 'graph.resync') &&
          message.repoId === repository.id
        ) {
          dispatch({
            type: 'patch',
            patch: {
              realtime:
                message.type === 'graph.resync'
                  ? 'resync-required'
                  : 'updated',
            },
          });
          reloadGraph();
          reloadOverlay();
          settleToConnected();
          return;
        }
        if (message.type === 'error' && message.code === 'unauthenticated') {
          dispatch({ type: 'patch', patch: { session: 'session-expired' } });
          socket?.close();
        }
      });
      socket.addEventListener('close', (event) => {
        if (event.code === 4401) {
          dispatch({ type: 'patch', patch: { session: 'session-expired' } });
          return;
        }
        scheduleReconnect();
      });
      socket.addEventListener('error', () => socket?.close());
    };

    connect();
    return () => {
      active = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: 'unsubscribe', repoId: repository.id }),
        );
      }
      socket?.close();
    };
  }, [
    allowLocalGatewayFallback,
    gatewayWsUrl,
    reloadGraph,
    reloadOverlay,
    repository,
    source.id,
  ]);

  const semanticState = useMemo<SemanticState>(
    () =>
      source.id === 'fixture'
        ? {
            status: state.semantic,
            reasonCode: null,
            reason: SEMANTIC_REASONS[state.semantic],
            updatedAt: '2026-07-25T14:12:00Z',
          }
        : providerSemantic,
    [providerSemantic, source.id, state.semantic],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      mode: source.id,
      state,
      dispatch,
      repositories,
      repository,
      authorizedForRepository,
      readiness,
      scope,
      graph,
      graphStatus,
      graphErrorStatus,
      semanticState,
      nodeOverlay,
      overlayStatus,
      isAdmin: state.role === 'admin' || state.role === 'owner',
      reloadCatalog,
      reloadGraph,
      reloadOverlay,
      saveAgentSkillMd,
      runOnboardingStep,
      loadProviderSettings: source.providerSettings,
      saveProviderSetting: source.saveProviderSetting,
      loadMcpSettings: source.mcpSettings,
      issueMcpKey: source.issueMcpKey,
      revokeMcpKey: source.revokeMcpKey,
      saveMcpRateLimit: source.saveMcpRateLimit,
      loadGitHubIntegrationStatus: source.githubIntegrationStatus,
      githubInstallUrl: source.githubInstallUrl,
      viewer: source.viewer,
    }),
    [
      authorizedForRepository,
      graph,
      graphErrorStatus,
      graphStatus,
      nodeOverlay,
      overlayStatus,
      readiness,
      reloadCatalog,
      reloadGraph,
      reloadOverlay,
      repositories,
      repository,
      saveAgentSkillMd,
      runOnboardingStep,
      scope,
      semanticState,
      source.id,
      source.githubIntegrationStatus,
      source.githubInstallUrl,
      source.issueMcpKey,
      source.mcpSettings,
      source.revokeMcpKey,
      source.saveMcpRateLimit,
      source.viewer,
      source.providerSettings,
      source.saveProviderSetting,
      state,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function MockProvider({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider source={fixtureWorkspaceDataSource}>
      {children}
    </WorkspaceProvider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (value === null) {
    throw new Error('useWorkspace must be used inside <WorkspaceProvider>.');
  }
  return value;
}

/** Compatibility alias for the presentational modules inherited from the mock. */
export const useMock = useWorkspace;

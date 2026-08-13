'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { WorkspaceDataSource, WorkspaceScope } from '../dataSource';
import type { BackendState, Repository, RepositoryAccess, RepositoryImportSync, RepositoryReadiness, Role, SessionState } from '../types';
import { getStoredSessionToken } from '../../lib/coreFetch';
import { statusOf, useWorkspaceStore } from './store';

const IDLE_SYNC: RepositoryImportSync = {
  status: 'idle',
  updatedAt: null,
  discoveredRepositories: null,
  registeredRepositories: null,
};

export interface WorkspaceSessionContextValue {
  mode: 'live' | 'fixture'; session: SessionState; role: Role; access: RepositoryAccess; backend: BackendState;
  isAdmin: boolean; repositories: readonly Repository[]; repository: Repository | null;
  authorizedForRepository: boolean; readiness: RepositoryReadiness; scope: WorkspaceScope | null;
  /** W7-01: the workspace's partial-sync indicator, from GET /repositories's `sync`. */
  sync: RepositoryImportSync;
  viewer: WorkspaceDataSource['viewer']; reloadCatalog(): void; signOut(): void;
}

const WorkspaceSessionContext = createContext<WorkspaceSessionContextValue | null>(null);

function visibleRepositories(mode: WorkspaceDataSource['id'], access: RepositoryAccess, catalog: Repository[]): Repository[] {
  if (access === 'no-repositories' || access === 'forbidden') return [];
  if (mode === 'fixture' && access === 'repository-restricted') return catalog.filter((repo) => repo.restricted !== true).slice(1);
  return catalog.filter((repo) => repo.restricted !== true);
}

export function WorkspaceSessionProvider({ children }: { children: ReactNode }) {
  const { state, dispatch, source } = useWorkspaceStore();
  const [catalog, setCatalog] = useState<Repository[]>([]);
  const [sync, setSync] = useState<RepositoryImportSync>(IDLE_SYNC);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const reloadCatalog = useCallback(() => setCatalogVersion((version) => version + 1), []);
  const repositories = useMemo(() => visibleRepositories(source.id, state.access, catalog), [catalog, source.id, state.access]);
  const authorizedRepository = repositories.find((item) => item.id === state.repositoryId) ?? null;
  const repository = authorizedRepository ?? catalog.find((item) => item.id === state.repositoryId) ?? repositories[0] ?? null;
  const authorizedForRepository = repository === null || repositories.some((item) => item.id === repository.id);
  const readiness = state.readinessOverride ?? repository?.readiness ?? 'registered';
  const refName = state.refName ?? repository?.currentRef ?? (repository?.defaultBranch ? `refs/heads/${repository.defaultBranch}` : null);
  const scope = useMemo<WorkspaceScope | null>(() => repository !== null && refName !== null
    ? { repositoryId: repository.id, refName }
    : null, [refName, repository]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void source.repositories(controller.signal).then(({ repositories: nextCatalog, sync: nextSync }) => {
      if (!active) return;
      setCatalog(nextCatalog);
      setSync(nextSync);
      const selected = nextCatalog.find((item) => item.id === state.repositoryId) ?? nextCatalog[0] ?? null;
      dispatch({ type: 'patch', patch: {
        backend: 'available',
        session: 'authenticated',
        access: source.id === 'live' ? (nextCatalog.length === 0 ? 'no-repositories' : 'authorized') : state.access,
        repositoryId: selected?.id ?? null,
        refName: selected === null ? null : state.repositoryId === selected.id
          ? state.refName
          : selected.currentRef ?? (selected.defaultBranch ? `refs/heads/${selected.defaultBranch}` : null),
      } });
    }).catch((error: unknown) => {
      if (!active || (error as { name?: string }).name === 'AbortError') return;
      const status = statusOf(error);
      if (status === 401) dispatch({ type: 'patch', patch: { session: getStoredSessionToken() === null ? 'signed-out' : 'session-expired' } });
      else if (status === 403) dispatch({ type: 'patch', patch: { access: 'forbidden' } });
      else dispatch({ type: 'patch', patch: { backend: 'unavailable' } });
    });
    return () => { active = false; controller.abort(); };
    // A reload deliberately reuses the selected repository/ref as preference inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogVersion, source]);

  useEffect(() => {
    if (source.id !== 'live' || state.session !== 'authenticated') return undefined;
    const controller = new AbortController();
    let active = true;
    void source.providerSettings(controller.signal).then(() => {
      if (active) dispatch({ type: 'patch', patch: { role: 'admin' } });
    }).catch((error: unknown) => {
      if (!active || (error as { name?: string }).name === 'AbortError') return;
      dispatch({ type: 'patch', patch: statusOf(error) === 401 ? { session: 'session-expired' } : { role: 'member' } });
    });
    return () => { active = false; controller.abort(); };
  }, [dispatch, source, state.session]);

  useEffect(() => {
    // W7-01 (AC-16): also re-poll while a sync is in flight, even with an empty catalog — a
    // large installation that is still importing has no `registered` repository yet, but the
    // workspace still needs to notice new rows landing. Deliberately NOT gated on
    // `state.session` (unlike the catalog-fetch effect above): that field is also written by the
    // unrelated admin-role-detection effect below, and re-arming/tearing down this timer on that
    // effect's own unrelated transitions would race the very re-poll this exists to guarantee. A
    // reload while genuinely unauthenticated is harmless — the fetch's own catch handler already
    // updates `session` from a real 401, same as any other catalog fetch.
    const syncInFlight = sync.status === 'importing';
    if (source.id !== 'live' || (!catalog.some((item) => item.readiness === 'registered') && !syncInFlight)) return undefined;
    const timer = setTimeout(reloadCatalog, 2_500);
    return () => clearTimeout(timer);
  }, [catalog, reloadCatalog, source.id, sync.status]);

  const value = useMemo<WorkspaceSessionContextValue>(() => ({
    mode: source.id,
    session: state.session,
    role: state.role,
    access: state.access,
    backend: state.backend,
    isAdmin: state.role === 'admin' || state.role === 'owner',
    repositories,
    repository,
    authorizedForRepository,
    readiness,
    scope,
    sync,
    viewer: source.viewer,
    reloadCatalog,
    signOut: () => dispatch({ type: 'patch', patch: { session: 'signed-out' } }),
  }), [authorizedForRepository, dispatch, readiness, reloadCatalog, repositories, repository, scope, source.id, source.viewer, state.access, state.backend, state.role, state.session, sync]);
  return <WorkspaceSessionContext.Provider value={value}>{children}</WorkspaceSessionContext.Provider>;
}

export function useWorkspaceSession(): WorkspaceSessionContextValue {
  const value = useContext(WorkspaceSessionContext);
  if (value === null) throw new Error('useWorkspaceSession must be used inside WorkspaceSessionProvider.');
  return value;
}

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clearSessionCookie,
  clearStoredSessionToken,
} from '../../lib/coreFetch';
import { useMock } from '../state';
import type { RealtimeStatus, RepositoryReadiness, SemanticStatus } from '../types';
import { Badge } from './ui';

const READINESS_LABEL: Record<RepositoryReadiness, string> = {
  registered: 'preparing repository',
  graph_ready: 'graph ready',
};

const SEMANTIC_LABEL: Record<SemanticStatus, string> = {
  generating: 'generating product tree',
  ready: 'semantics ready',
  degraded: 'semantics degraded',
  failed: 'semantics unavailable',
};

const REALTIME_LABEL: Record<RealtimeStatus, string> = {
  connected: 'live',
  reconnecting: 'reconnecting to live updates',
  updated: 'graph updated',
  'resync-required': 'resync required',
  'not-connected': 'live updates offline',
};

function RepositoryPicker() {
  const { state, dispatch, repositories, repository } = useMock();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocumentClick = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  const label = repository?.name ?? 'no repository';

  return (
    <div className="mock-picker" ref={container}>
      <button
        type="button"
        className="mock-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={state.access === 'forbidden'}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <span className="mock-picker-caret">▾</span>
      </button>

      {open && (
        <div className="mock-picker-menu" role="listbox" aria-label="Authorized repositories">
          {repositories.length === 0 ? (
            <div className="mock-picker-empty">
              <strong>No repositories available</strong>
              {state.access === 'no-repositories'
                ? 'No repository has been connected to this organization yet. An administrator can install the GitHub App from Settings.'
                : 'Your account is not authorized for any repository in this organization.'}
            </div>
          ) : (
            repositories.map((repo) => (
              <button
                key={repo.id}
                type="button"
                role="option"
                className="mock-picker-option"
                aria-current={repo.id === repository?.id}
                aria-selected={repo.id === repository?.id}
                onClick={() => {
                  dispatch({
                    type: 'patch',
                    patch: {
                      repositoryId: repo.id,
                      refName:
                        repo.currentRef ??
                        (repo.defaultBranch
                          ? `refs/heads/${repo.defaultBranch}`
                          : null),
                      selectedNodeId: null,
                      selectedFeatureId: null,
                      drawerOpen: false,
                    },
                  });
                  setOpen(false);
                }}
              >
                <span className="mock-picker-name">
                  {repo.name}
                </span>
                <span className="mock-picker-meta">
                  {repo.provider} · default {repo.defaultBranch ?? 'unknown'} ·{' '}
                  {READINESS_LABEL[repo.readiness]}
                </span>
              </button>
            ))
          )}

          {state.access === 'repository-restricted' && repositories.length > 0 && (
            <div className="mock-picker-empty">
              Only repositories your role grants access to appear here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const {
    mode,
    state,
    dispatch,
    repository,
    authorizedForRepository,
    readiness,
    semanticState,
    isAdmin,
  } = useMock();

  const readinessTone =
    readiness === 'graph_ready' ? 'ready' : 'working';

  const semanticTone =
    semanticState.status === 'ready'
      ? 'ready'
      : semanticState.status === 'generating'
        ? 'working'
        : semanticState.status === 'degraded'
          ? 'warn'
          : 'danger';

  const realtimeTone =
    state.realtime === 'connected'
      ? 'ready'
      : state.realtime === 'updated'
        ? 'neutral'
        : state.realtime === 'reconnecting'
          ? 'working'
          : 'warn';

  return (
    <header className="mock-topbar">
      <span className="mock-wordmark">sayre_</span>
      <span className="mock-divider" />

      <RepositoryPicker />

      {/* Readiness and semantic state describe the repository's graph, so they
          are withheld for a repository the viewer is not authorized to read. */}
      {repository !== null && authorizedForRepository && (
        <>
          {/* Read-only on purpose: the catalogue returns the current authorized
              ref, not a selectable list, so there is nothing to switch between
              until a refs API exists. */}
          <Badge dot={false}>
            ref {repository.currentRef?.replace(/^refs\/heads\//u, '') ?? 'pending'}
          </Badge>
          <Badge tone={readinessTone}>{READINESS_LABEL[readiness]}</Badge>
          <Badge tone={semanticTone}>
            {SEMANTIC_LABEL[semanticState.status]}
          </Badge>
          {/* The gateway re-authorizes every pushed delta before this client
              refreshes its currently selected graph projection. */}
          <Badge tone={realtimeTone}>{REALTIME_LABEL[state.realtime]}</Badge>
        </>
      )}

      <span className="mock-topbar-spacer" />

      {mode === 'fixture' && (
        <button
          type="button"
          className="mock-btn mock-btn-ghost"
          onClick={() =>
            dispatch({ type: 'patch', patch: { controlsOpen: true } })
          }
        >
          Mock controls
        </button>
      )}

      {/* Every settings section is admin-only, so members never see the entry
          point at all — the actions are absent, not disabled. */}
      {isAdmin && (
        <button
          type="button"
          className="mock-btn mock-btn-secondary mock-btn-sm"
          onClick={() =>
            dispatch({
              type: 'patch',
              patch: { settingsSection: 'github' },
            })
          }
        >
          Settings
        </button>
      )}

      <AccountMenu />
    </header>
  );
}

function AccountMenu() {
  const { mode, state, dispatch, viewer } = useMock();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocumentClick = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  const currentUser = viewer;

  return (
    <div className="mock-picker" ref={container}>
      <button
        type="button"
        className="mock-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${currentUser.name}`}
        onClick={() => setOpen((value) => !value)}
      >
        {currentUser.initials}
      </button>

      {open && (
        <div className="mock-picker-menu" role="menu" style={{ left: 'auto', right: 0, width: 250 }}>
          <div className="mock-picker-empty">
            <strong>{currentUser.name}</strong>
            {currentUser.email}
            <span className="mock-picker-meta">
              {currentUser.org} · {state.role}
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="mock-picker-option"
            onClick={() => {
              setOpen(false);
              dispatch({ type: 'patch', patch: { session: 'signed-out' } });
              if (mode === 'live') {
                clearStoredSessionToken();
                void clearSessionCookie()
                  .catch(() => undefined)
                  .finally(() => window.location.assign('/login'));
              }
            }}
          >
            <span className="mock-picker-name">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { CURRENT_USER } from '../fixtures';
import { useMock } from '../state';
import type { RealtimeStatus, RepositoryReadiness, SemanticStatus } from '../types';
import { Badge } from './ui';

const READINESS_LABEL: Record<RepositoryReadiness, string> = {
  registered: 'preparing repository',
  'technical-ready': 'technical tree ready',
  'graph-ready': 'graph ready',
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

  const label =
    repository === null
      ? 'no repository'
      : `${repository.owner}/${repository.name}`;

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
                      selectedNodeId: null,
                      selectedFeatureId: null,
                      drawerOpen: false,
                    },
                  });
                  setOpen(false);
                }}
              >
                <span className="mock-picker-name">
                  {repo.owner}/{repo.name}
                </span>
                <span className="mock-picker-meta">
                  github · default {repo.defaultBranch} ·{' '}
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
  const { state, dispatch, repository, authorizedForRepository, readiness, isAdmin } =
    useMock();

  const readinessTone =
    readiness === 'graph-ready'
      ? 'ready'
      : readiness === 'technical-ready'
        ? 'neutral'
        : 'working';

  const semanticTone =
    state.semantic === 'ready'
      ? 'ready'
      : state.semantic === 'generating'
        ? 'working'
        : state.semantic === 'degraded'
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
          <Badge dot={false}>ref {repository.currentRef}</Badge>
          <Badge tone={readinessTone}>{READINESS_LABEL[readiness]}</Badge>
          <Badge tone={semanticTone}>{SEMANTIC_LABEL[state.semantic]}</Badge>
          {/* Reserved sync indicator — the gateway exists, the client does not
              consume it yet, so this reports state and controls nothing. */}
          <Badge tone={realtimeTone}>{REALTIME_LABEL[state.realtime]}</Badge>
        </>
      )}

      <span className="mock-topbar-spacer" />

      <button
        type="button"
        className="mock-btn mock-btn-ghost"
        onClick={() => dispatch({ type: 'patch', patch: { controlsOpen: true } })}
      >
        Mock controls
      </button>

      {/* Both settings sections are admin-only, so members never see the entry
          point at all — the actions are absent, not disabled. */}
      {isAdmin && (
        <button
          type="button"
          className="mock-btn mock-btn-secondary mock-btn-sm"
          onClick={() =>
            dispatch({ type: 'patch', patch: { settingsSection: 'github' } })
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
  const { state, dispatch } = useMock();
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

  return (
    <div className="mock-picker" ref={container}>
      <button
        type="button"
        className="mock-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${CURRENT_USER.name}`}
        onClick={() => setOpen((value) => !value)}
      >
        {CURRENT_USER.initials}
      </button>

      {open && (
        <div className="mock-picker-menu" role="menu" style={{ left: 'auto', right: 0, width: 250 }}>
          <div className="mock-picker-empty">
            <strong>{CURRENT_USER.name}</strong>
            {CURRENT_USER.email}
            <span className="mock-picker-meta">
              {CURRENT_USER.org} · {state.role}
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="mock-picker-option"
            onClick={() => {
              setOpen(false);
              dispatch({ type: 'patch', patch: { session: 'signed-out' } });
            }}
          >
            <span className="mock-picker-name">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

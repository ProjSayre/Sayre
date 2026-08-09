'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clearSessionCookie,
  clearStoredSessionToken,
} from '../../lib/coreFetch';
import { useWorkspaceNavigation, useWorkspaceRealtime, useWorkspaceSession } from '../state';
import type { RealtimeStatus, RepositoryReadiness } from '../types';
import { Badge } from './ui';

const READINESS_LABEL: Record<RepositoryReadiness, string> = {
  registered: 'preparing repository',
  graph_ready: 'graph ready',
};

const REALTIME_LABEL: Record<RealtimeStatus, string> = {
  connected: 'live',
  reconnecting: 'reconnecting to live updates',
  updated: 'graph updated',
  'resync-required': 'resync required',
  'not-connected': 'live updates offline',
};

function RepositoryPicker() {
  const { access, repositories, repository, isAdmin } = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
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
        disabled={access === 'forbidden'}
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
              <span>
                {access === 'no-repositories'
                  ? 'No repository has been connected to this organization yet.'
                  : 'Your account is not authorized for any repository in this organization.'}
              </span>
              {access === 'no-repositories' && isAdmin && (
                <button
                  type="button"
                  className="mock-btn mock-btn-primary mock-btn-sm"
                  onClick={() => {
                    navigation.openSettings('github');
                    setOpen(false);
                  }}
                >
                  Connect repository
                </button>
              )}
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
                  navigation.selectRepository(repo.id);
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

          {access === 'repository-restricted' && repositories.length > 0 && (
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
  const session = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const realtime = useWorkspaceRealtime();

  const realtimeTone =
    realtime.status === 'connected'
      ? 'ready'
      : realtime.status === 'updated'
        ? 'neutral'
        : realtime.status === 'reconnecting'
          ? 'working'
          : 'warn';

  return (
    <header className="mock-topbar">
      <span className="mock-wordmark">sayre_</span>
      <span className="mock-divider" />

      <RepositoryPicker />

      {/* The ref, readiness, and semantic badges that used to sit here only ever
          restated what another surface already says: PreparingState covers a
          repository that is not graph-ready, StatusBanner covers every semantic
          status in fuller language, and the ref is not selectable. Realtime is
          the exception — nothing else reports a dropped connection — so it
          appears only when it has something to report. Still withheld for a
          repository the viewer is not authorized to read. */}
      {session.repository !== null &&
        session.authorizedForRepository &&
        realtime.status !== 'connected' && (
          // The gateway re-authorizes every pushed delta before this client
          // refreshes its currently selected graph projection.
          <Badge tone={realtimeTone}>{REALTIME_LABEL[realtime.status]}</Badge>
        )}

      <span className="mock-topbar-spacer" />

      {session.mode === 'fixture' && (
        <button
          type="button"
          className="mock-btn mock-btn-ghost"
          onClick={() => navigation.setControlsOpen(true)}
        >
          Mock controls
        </button>
      )}

      {/* Every settings section is admin-only, so members never see the entry
          point at all — the actions are absent, not disabled. */}
      {session.isAdmin && (
        <button
          type="button"
          className="mock-btn mock-btn-secondary mock-btn-sm"
          onClick={() => navigation.openSettings('github')}
        >
          Settings
        </button>
      )}

      <AccountMenu />
    </header>
  );
}

function AccountMenu() {
  const session = useWorkspaceSession();
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

  const currentUser = session.viewer;

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
              {currentUser.org} · {session.role}
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="mock-picker-option"
            onClick={() => {
              setOpen(false);
              session.signOut();
              if (session.mode === 'live') {
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

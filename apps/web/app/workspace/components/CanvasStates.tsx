'use client';

import type { ReactNode } from 'react';
import { useWorkspaceNavigation, useWorkspaceQueries, useWorkspaceSession } from '../state';
import type { RepositoryImportSync } from '../types';

function CanvasState({
  state,
  title,
  role = 'status',
  children,
}: {
  state: string;
  title: string;
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div className="mock-canvas-state" role={role} data-canvas-state={state}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function NoRepositoryState({ reason }: { reason: 'none' | 'restricted' }) {
  const { isAdmin } = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  return (
    <CanvasState state="no-repository" title="No repository selected">
      {reason === 'none' ? (
        <>
          <p>
            No repository has been connected to this organization yet. Once an
            administrator installs the GitHub App and picks repositories, they
            appear in the picker above.
          </p>
          <p>Nothing is loaded, so there is nothing to explore on this canvas.</p>
          {isAdmin && (
            <button
              type="button"
              className="mock-btn mock-btn-primary"
              onClick={() => navigation.openSettings('github')}
            >
              Connect a GitHub repository
            </button>
          )}
        </>
      ) : (
        <p>
          Your account is not authorized for any repository in this organization.
          Ask an administrator to grant access.
        </p>
      )}
    </CanvasState>
  );
}

/**
 * W7-01 (AC-16): the partial-sync indicator. `variant: 'canvas'` replaces the misleading "No
 * repository has been connected" canvas state while the very first page of a large installation
 * is still landing (no repository is selectable yet); `variant: 'chip'` renders alongside the
 * canvas once at least one repository IS selectable, so the indicator never blocks work that can
 * already proceed. Deliberately reads no context — a plain presentational component so it can be
 * driven entirely by the `sync` prop (including in isolation, outside any provider).
 */
export function ImportingRepositoriesState({
  sync,
  variant,
}: {
  sync: RepositoryImportSync;
  variant: 'canvas' | 'chip';
}) {
  const label = sync.status === 'stalled' ? 'Import stalled' : 'Importing repositories';
  const countLabel =
    sync.discoveredRepositories !== null && sync.registeredRepositories !== null
      ? `${sync.registeredRepositories} of ${sync.discoveredRepositories} repositories imported so far.`
      : null;

  if (variant === 'chip') {
    return (
      <span
        className="mock-repository-import-chip"
        data-repository-import={sync.status}
        role="status"
      >
        {label}
        {countLabel ? ` — ${countLabel}` : ''}
      </span>
    );
  }

  return (
    <CanvasState state="importing-repositories" title={label}>
      <p>
        {sync.status === 'stalled'
          ? 'The import has not made progress recently. It will resume automatically — nothing has been lost.'
          : "We're still importing this organization's repositories. The list keeps filling in on its own — no action needed."}
      </p>
      {countLabel && <p>{countLabel}</p>}
    </CanvasState>
  );
}

export function PreparingState({ repositoryLabel }: { repositoryLabel: string }) {
  return (
    <CanvasState state="preparing" title="Preparing repository">
      <p>
        <code>{repositoryLabel}</code> is registered and its structure is being
        read for the first time. The Technical Tree opens here as soon as it is
        ready.
      </p>
      <p>This usually takes a few minutes for a repository this size.</p>
    </CanvasState>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <CanvasState state="loading" title={`Loading ${label}`}>
      <p>Requesting the repository context for this ref.</p>
    </CanvasState>
  );
}

export function EmptyGraphState() {
  return (
    <CanvasState state="empty" title="Nothing to show on this ref">
      <p>
        The repository is authorized and prepared, but this ref produced no
        Folder or File nodes you can view.
      </p>
    </CanvasState>
  );
}

export function ForbiddenState() {
  return (
    <CanvasState state="repository-forbidden" title="You do not have access to this repository" role="alert">
      <p>
        Your role does not grant access to this repository&apos;s graph. Ask an
        administrator if you think this is wrong.
      </p>
    </CanvasState>
  );
}

export function UnavailableState() {
  const { reloadGraph } = useWorkspaceQueries();
  return (
    <CanvasState state="graph-unavailable" title="Sayre is unavailable right now" role="alert">
      <p>
        The graph could not be reached. Nothing has been lost — reload the page
        once the service is back.
      </p>
      <button
        type="button"
        className="mock-btn mock-btn-secondary"
        data-canvas-recovery-action="reload-graph"
        onClick={reloadGraph}
      >
        Try again
      </button>
    </CanvasState>
  );
}

export function ProductUnavailableState({
  reason,
}: {
  reason: 'generating' | 'failed';
}) {
  const navigation = useWorkspaceNavigation();
  return (
    <CanvasState state={`product-${reason}`} title={reason === 'generating' ? 'Generating Product Tree' : 'Product Tree unavailable'}>
      <p>
        {reason === 'generating'
          ? 'Feature boundaries for this ref are still being generated. They appear here as they land.'
          : 'Feature boundaries could not be generated for this ref. The Technical Tree is unaffected and still shows the full repository structure.'}
      </p>
      <button
        type="button"
        className="mock-btn mock-btn-secondary"
        onClick={() => { navigation.selectView('technical'); navigation.setFileTreeOpen(true); }}
      >
        Open Technical Tree
      </button>
    </CanvasState>
  );
}

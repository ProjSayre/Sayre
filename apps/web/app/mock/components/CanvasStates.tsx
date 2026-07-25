'use client';

import type { ReactNode } from 'react';

function CanvasState({
  title,
  role = 'status',
  children,
}: {
  title: string;
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div className="mock-canvas-state" role={role}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function NoRepositoryState({ reason }: { reason: 'none' | 'restricted' }) {
  return (
    <CanvasState title="No repository selected">
      {reason === 'none' ? (
        <>
          <p>
            No repository has been connected to this organization yet. Once an
            administrator installs the GitHub App and picks repositories, they
            appear in the picker above.
          </p>
          <p>Nothing is loaded, so there is nothing to explore on this canvas.</p>
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

export function PreparingState({ repositoryLabel }: { repositoryLabel: string }) {
  return (
    <CanvasState title="Preparing repository">
      <p>
        <code>{repositoryLabel}</code> is registered and its structure is being
        read for the first time. The Technical Tree opens here as soon as it is
        ready.
      </p>
      <p>This usually takes a few minutes for a repository this size.</p>
    </CanvasState>
  );
}

export function LoadingState() {
  return (
    <CanvasState title="Loading Technical Tree">
      <p>Requesting the authorized Folder and File projection for this ref.</p>
    </CanvasState>
  );
}

export function EmptyGraphState() {
  return (
    <CanvasState title="Nothing to show on this ref">
      <p>
        The repository is authorized and prepared, but this ref produced no
        Folder or File nodes you can view.
      </p>
    </CanvasState>
  );
}

export function ForbiddenState() {
  return (
    <CanvasState title="You do not have access to this repository" role="alert">
      <p>
        Your role does not grant access to this repository&apos;s graph. Ask an
        administrator if you think this is wrong.
      </p>
    </CanvasState>
  );
}

export function UnavailableState() {
  return (
    <CanvasState title="Sayre is unavailable right now" role="alert">
      <p>
        The graph could not be reached. Nothing has been lost — reload the page
        once the service is back.
      </p>
    </CanvasState>
  );
}

export function ProductUnavailableState({
  reason,
}: {
  reason: 'generating' | 'failed';
}) {
  return (
    <CanvasState title={reason === 'generating' ? 'Generating Product Tree' : 'Product Tree unavailable'}>
      <p>
        {reason === 'generating'
          ? 'Feature boundaries for this ref are still being generated. They appear here as they land.'
          : 'Feature boundaries could not be generated for this ref. The Technical Tree is unaffected and still shows the full repository structure.'}
      </p>
    </CanvasState>
  );
}

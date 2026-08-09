'use client';

import { useWorkspaceFixture, useWorkspaceSession } from '../state';

/**
 * Whole-app states. These replace the workspace entirely rather than layering a
 * dialog over data the viewer may no longer be entitled to see.
 */
export function GlobalStates() {
  const session = useWorkspaceSession();
  const fixture = useWorkspaceFixture();

  const startSignIn = (): void => {
    if (fixture !== null) {
      fixture.patch({ session: 'authenticated' });
      return;
    }
    window.location.assign('/login');
  };

  if (session.session === 'signed-out') {
    return (
      <div className="mock-fullstate" data-global-state="signed-out">
        <div className="mock-fullstate-card">
          <span className="mock-wordmark">sayre_</span>
          <h2>Sign in to continue</h2>
          <p>
            Sayre shows only the repositories your account is authorized for, so
            it needs to know who you are before anything loads.
          </p>
          <div className="mock-fullstate-actions">
            <button
              type="button"
              className="mock-btn mock-btn-primary"
              onClick={startSignIn}
            >
              Sign in with GitHub
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (session.session === 'session-expired') {
    return (
      <div className="mock-fullstate" data-global-state="session-expired">
        <div className="mock-fullstate-card">
          <span className="mock-wordmark">sayre_</span>
          <h2>Your session expired</h2>
          <p>
            You were signed out after a period of inactivity. Signing in again
            returns you to the repository and view you were on.
          </p>
          <div className="mock-fullstate-actions">
            <button
              type="button"
              className="mock-btn mock-btn-primary"
              onClick={startSignIn}
            >
              Sign in again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (session.backend === 'unavailable') {
    return (
      <div className="mock-fullstate" data-global-state="backend-unavailable">
        <div className="mock-fullstate-card">
          <span className="mock-wordmark">sayre_</span>
          <h2>Sayre is unavailable right now</h2>
          <p>
            The service could not be reached. Your repositories and their graphs
            are unaffected — reload once it is back.
          </p>
          <div className="mock-fullstate-actions">
            <button
              type="button"
              className="mock-btn mock-btn-secondary"
              onClick={session.reloadCatalog}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (session.access === 'forbidden') {
    return (
      <div className="mock-fullstate" data-global-state="organization-forbidden">
        <div className="mock-fullstate-card">
          <span className="mock-wordmark">sayre_</span>
          <h2>You do not have access to this organization</h2>
          <p>
            Your account is signed in but is not a member of an organization with
            a Sayre workspace. An administrator can add you.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

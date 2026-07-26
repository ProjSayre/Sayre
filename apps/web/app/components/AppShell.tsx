import Link from 'next/link';
import { GraphCanvas } from './GraphCanvas';

const views = [
  { label: 'Technical', icon: 'T', active: true },
  { label: 'Product', icon: 'P', active: false },
  { label: 'Onboarding', icon: 'O', active: false },
];

interface AppShellProps {
  repoId: string | null;
  providerStateRepositoryId: string | null;
  refName: string;
}

function productTreeHref(repoId: string | null, refName: string): string {
  if (repoId === null) return '/product';
  const query = new URLSearchParams({
    repoId,
    ref: refName,
  });
  return `/product?${query.toString()}`;
}

function onboardingTreeHref(repoId: string | null, refName: string): string {
  if (repoId === null) return '/onboarding';
  const query = new URLSearchParams({ repoId, ref: refName });
  return `/onboarding?${query.toString()}`;
}

export function AppShell({
  repoId,
  providerStateRepositoryId,
  refName,
}: AppShellProps) {
  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Sayre home">
          <span className="brand-mark">S</span>
          sayre
        </Link>
        <div className="repo-crumb">
          repositories <span>/</span> <strong>{repoId ?? 'not selected'}</strong>
        </div>
        <div className="topbar-actions">
          <span className="branch-pill">Technical</span>
          <span className="sync-pill">
            {repoId === null ? 'Selection required' : 'Server-authorized'}
          </span>
          <Link className="settings-link" href="/settings/providers">
            Provider settings
          </Link>
          <Link className="avatar" href="/login" aria-label="Open account sign in">
            AK
          </Link>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <p className="sidebar-label">Graph views</p>
          <nav className="nav-list" aria-label="Graph views">
            {views.map((view) => (
              view.label === 'Product' || view.label === 'Onboarding' ? (
                <Link
                  className="nav-item"
                  href={
                    view.label === 'Product'
                      ? productTreeHref(repoId, refName)
                      : onboardingTreeHref(repoId, refName)
                  }
                  key={view.label}
                >
                  <span className="nav-icon">{view.icon}</span>
                  {view.label}
                </Link>
              ) : (
                <button
                  className={`nav-item${view.active ? ' active' : ''}`}
                  key={view.label}
                  type="button"
                  aria-current={view.active ? 'page' : undefined}
                >
                  <span className="nav-icon">{view.icon}</span>
                  {view.label}
                </button>
              )
            ))}
          </nav>

          <section className="repo-card" aria-labelledby="repository-summary">
            <h2 id="repository-summary">Repository map</h2>
            <p>
              {repoId === null
                ? 'Choose a registered repository to load its Technical Tree.'
                : 'Live Folder/File data from the authorized graph projection.'}
            </p>
            {repoId !== null && <code className="repo-id">{repoId}</code>}
          </section>

          <p className="sidebar-footer">
            Drag to pan. Scroll to zoom. Select a node to inspect its graph path.
          </p>
        </aside>

        <section className="canvas-wrap">
          <div className="canvas-heading">
            <h1>Technical tree</h1>
            <p>Folder/File structure · containment and imports</p>
          </div>
          <GraphCanvas
            repoId={repoId}
            providerStateSelection={
              providerStateRepositoryId === null
                ? null
                : {
                    repositoryId: providerStateRepositoryId,
                    refName,
                    surface: 'product',
                  }
            }
          />
        </section>
      </div>
    </main>
  );
}

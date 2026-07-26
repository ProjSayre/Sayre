import Link from 'next/link';
import { OnboardingTreeCanvas } from './OnboardingTreeCanvas';

interface OnboardingTreeShellProps {
  repoId: string | null;
  refName: string;
}

function treeHref(path: string, repoId: string | null, refName: string): string {
  if (repoId === null) return path;
  return `${path}?${new URLSearchParams({ repoId, ref: refName })}`;
}

export function OnboardingTreeShell({
  repoId,
  refName,
}: OnboardingTreeShellProps) {
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
          <span className="branch-pill">{refName.replace(/^refs\/heads\//u, '')}</span>
          <span className="sync-pill">
            {repoId === null ? 'Selection required' : 'Server-authorized'}
          </span>
          <Link className="avatar" href="/login" aria-label="Open account sign in">
            AK
          </Link>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <p className="sidebar-label">Graph views</p>
          <nav className="nav-list" aria-label="Graph views">
            <Link className="nav-item" href={treeHref('/', repoId, refName)}>
              <span className="nav-icon">T</span>
              Technical
            </Link>
            <Link className="nav-item" href={treeHref('/product', repoId, refName)}>
              <span className="nav-icon">P</span>
              Product
            </Link>
            <Link
              className="nav-item active"
              href={treeHref('/onboarding', repoId, refName)}
              aria-current="page"
            >
              <span className="nav-icon">O</span>
              Onboarding
            </Link>
          </nav>
          <section className="repo-card">
            <h2>Safe setup</h2>
            <p>
              EnvStep metadata stays graph-internal. Only authorized Folder and
              File nodes render on the canvas.
            </p>
          </section>
          <p className="sidebar-footer">
            Commands run in a disposable, networkless container without host mounts.
          </p>
        </aside>

        <section className="canvas-wrap">
          <div className="canvas-heading">
            <h1>Onboarding tree</h1>
            <p>Ordered setup · isolated execution</p>
          </div>
          <OnboardingTreeCanvas repoId={repoId} refName={refName} />
        </section>
      </div>
    </main>
  );
}

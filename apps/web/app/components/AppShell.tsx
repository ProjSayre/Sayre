import Link from 'next/link';
import { GraphCanvas } from './GraphCanvas';

const views = [
  { label: 'Technical', icon: 'T', active: true },
  { label: 'Product', icon: 'P', active: false },
  { label: 'Onboarding', icon: 'O', active: false },
];

export function AppShell() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Sayre home">
          <span className="brand-mark">S</span>
          sayre
        </Link>
        <div className="repo-crumb">
          acme-engineering <span>/</span> <strong>sayre</strong>
        </div>
        <div className="topbar-actions">
          <span className="branch-pill">main</span>
          <span className="sync-pill">Synced 12s ago</span>
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
              <button
                className={`nav-item${view.active ? ' active' : ''}`}
                key={view.label}
                type="button"
                aria-current={view.active ? 'page' : undefined}
              >
                <span className="nav-icon">{view.icon}</span>
                {view.label}
              </button>
            ))}
          </nav>

          <section className="repo-card" aria-labelledby="repository-summary">
            <h2 id="repository-summary">Repository map</h2>
            <p>Static foundation fixture for the first interactive canvas.</p>
            <div className="repo-stats">
              <div className="repo-stat">
                <strong>20</strong>
                <span>Nodes</span>
              </div>
              <div className="repo-stat">
                <strong>19</strong>
                <span>Edges</span>
              </div>
              <div className="repo-stat">
                <strong>9</strong>
                <span>Folders</span>
              </div>
              <div className="repo-stat">
                <strong>11</strong>
                <span>Files</span>
              </div>
            </div>
          </section>

          <p className="sidebar-footer">
            Drag to pan. Scroll to zoom. Select a node to inspect its graph path.
          </p>
        </aside>

        <section className="canvas-wrap">
          <div className="canvas-heading">
            <h1>Technical tree</h1>
            <p>Folder and file structure · main</p>
          </div>
          <GraphCanvas />
        </section>
      </div>
    </main>
  );
}

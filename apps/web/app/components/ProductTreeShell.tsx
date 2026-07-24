import Link from 'next/link';
import { ProductTreeCanvas } from './ProductTreeCanvas';

interface ProductTreeShellProps {
  repoId: string | null;
  refName: string;
}

function treeHref(path: string, repoId: string | null, refName: string): string {
  if (repoId === null) return path;
  const query = new URLSearchParams({ repoId, ref: refName });
  return `${path}?${query}`;
}

export function ProductTreeShell({
  repoId,
  refName,
}: ProductTreeShellProps) {
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
            <Link
              className="nav-item"
              href={treeHref('/', repoId, refName)}
            >
              <span className="nav-icon">T</span>
              Technical
            </Link>
            <Link
              className="nav-item active"
              href={treeHref('/product', repoId, refName)}
              aria-current="page"
            >
              <span className="nav-icon">P</span>
              Product
            </Link>
            <button className="nav-item" type="button" disabled>
              <span className="nav-icon">O</span>
              Onboarding
            </button>
          </nav>

          <section className="repo-card" aria-labelledby="product-summary">
            <h2 id="product-summary">Feature clusters</h2>
            <p>
              Dashed boundaries and metadata come from the current,
              server-authorized graph projection.
            </p>
            {repoId !== null && <code className="repo-id">{repoId}</code>}
          </section>

          <p className="sidebar-footer">
            Select a dashed boundary to inspect its authorized Feature metadata.
          </p>
        </aside>

        <section className="canvas-wrap">
          <div className="canvas-heading">
            <h1>Product tree</h1>
            <p>Feature clusters · {refName.replace(/^refs\/heads\//u, '')}</p>
          </div>
          <ProductTreeCanvas repoId={repoId} refName={refName} />
        </section>
      </div>
    </main>
  );
}

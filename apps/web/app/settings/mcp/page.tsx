import Link from 'next/link';
import { McpSettingsPanel } from './McpSettingsPanel';

export default function McpSettingsPage() {
  return (
    <main className="settings-page">
      <header className="settings-header">
        <Link className="brand" href="/" aria-label="Return to Sayre">
          <span className="brand-mark">S</span>
          sayre
        </Link>
        <Link className="settings-back" href="/">
          Back to graph
        </Link>
      </header>
      <div className="settings-content">
        <div className="settings-title">
          <span className="settings-eyebrow">Organization admin</span>
          <h1>MCP agent access</h1>
          <p>
            Issue read-only, graph-scoped credentials for external MCP clients.
            Tokens appear once; revocation takes effect on the next call.
          </p>
        </div>
        <McpSettingsPanel />
      </div>
    </main>
  );
}

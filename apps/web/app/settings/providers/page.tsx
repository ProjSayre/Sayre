import Link from 'next/link';
import { ProviderSettingsPanel } from './ProviderSettingsPanel';

export default function ProviderSettingsPage() {
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
          <h1>Model provider settings</h1>
          <p>
            Choose the models behind enrichment, chatbot generation, and embeddings.
            Changes are read from tenant-scoped configuration by the next job—no
            deploy required.
          </p>
        </div>
        <ProviderSettingsPanel />
      </div>
    </main>
  );
}

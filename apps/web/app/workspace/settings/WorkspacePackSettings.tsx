'use client';

import { useState, type ChangeEvent } from 'react';
import type { InstalledWorkspacePack, WorkspacePackRef } from '../../../../../packages/workspace-packs/src/runtime';
import { useWorkspacePack } from '../packs/WorkspacePackProvider';
import { downloadWorkspacePack } from './workspacePackDownload';

interface ForkDraft {
  source: WorkspacePackRef;
  id: string;
  name: string;
  version: string;
  author: string;
}

const sourceLabels = {
  builtin: 'Built-in',
  imported: 'Imported',
  forked: 'Personal fork',
} as const;

function WorkspacePackCard({
  item,
  active,
  children,
  onActivate,
  onFork,
  onExport,
  onUninstall,
}: {
  item: InstalledWorkspacePack;
  active: boolean;
  children: string;
  className: string;
  onActivate(): void;
  onFork(): void;
  onExport(): void;
  onUninstall(): void;
}) {
  return (
    <li className={`workspace-pack-card-surface${active ? ' is-active' : ''}`} data-pack-name={children}>
      <div className="workspace-pack-card__summary">
        <div className="workspace-pack-card__identity">
          <strong>{item.pack.metadata.name}</strong>
          <p>{item.pack.metadata.description}</p>
        </div>
        <div className="workspace-pack-card__badges" aria-label="Pack status">
          {active && <span className="workspace-pack-badge workspace-pack-badge--active">Active</span>}
          <span className="workspace-pack-badge">{sourceLabels[item.source]}</span>
          <span className="workspace-pack-badge">v{item.ref.version}</span>
        </div>
      </div>
      <dl className="workspace-pack-card__details">
        <div><dt>Author</dt><dd>{item.pack.metadata.author}</dd></div>
        <div><dt>Setup ID</dt><dd>{item.ref.id}</dd></div>
      </dl>
      <div className="workspace-pack-card__actions" aria-label={`Actions for ${item.pack.metadata.name}`}>
        {!active && <button className="mock-btn mock-btn-primary" type="button" onClick={onActivate}>Activate</button>}
        <button className="mock-btn mock-btn-secondary" type="button" onClick={onFork}>Fork with new identity</button>
        <button className="mock-btn mock-btn-ghost" type="button" onClick={onExport}>Export</button>
        {item.source !== 'builtin' && <button className="mock-btn mock-btn-danger" type="button" onClick={onUninstall}>Uninstall</button>}
      </div>
    </li>
  );
}

export function WorkspacePackSettings() {
  const { store, activePackRef, activatePack } = useWorkspacePack();
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [forkDraft, setForkDraft] = useState<ForkDraft | null>(null);
  const packs = store.list();
  void revision;

  const importPack = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const installed = store.install(await file.text());
      setMessage(installed.ok ? 'Workspace Pack installed.' : installed.violations.map((item) => item.message).join(' '));
      if (installed.ok) setRevision((value) => value + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Workspace Pack import could not be read.');
    } finally {
      input.value = '';
    }
  };

  const exportPack = (id: string, version: string) => {
    try {
      const json = store.export({ id, version });
      downloadWorkspacePack(json, `${id}-${version}.workspace.json`);
      setMessage(`Exported ${id}@${version}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Workspace Pack export failed. No file was produced.');
    }
  };

  const materializeFork = () => {
    if (forkDraft === null) return;
    try {
      const installed = store.fork(forkDraft.source, {
        id: forkDraft.id.trim(),
        name: forkDraft.name.trim(),
        version: forkDraft.version.trim(),
        author: forkDraft.author.trim(),
      });
      setForkDraft(null);
      setRevision((value) => value + 1);
      setMessage(`Created ${installed.ref.id}@${installed.ref.version}. Activate it when ready.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Workspace Pack fork failed.');
    }
  };

  return (
    <section className="mock-card workspace-pack-settings">
      <div className="mock-card-head">
        <div>
          <h3>Workspace Packs</h3>
          <p>Choose how the product workspace looks and behaves. Imported packs contain validated setup data, never executable code.</p>
        </div>
        <label className="mock-btn mock-btn-secondary workspace-pack-import">
          Import and install
          <input type="file" accept="application/json,.json" onChange={importPack} hidden />
        </label>
      </div>
      <p className="workspace-pack-feedback" role="status" aria-live="polite">
        {message || 'Workspace changes are stored in this browser.'}
      </p>
      <ul className="workspace-pack-list" aria-label="Installed Workspace Packs">
        {packs.map((item) => {
          const active = item.ref.id === activePackRef.id && item.ref.version === activePackRef.version;
          return (
            <WorkspacePackCard
              key={`${item.ref.id}@${item.ref.version}`}
              className={`workspace-pack-card${active ? ' is-active' : ''}`}
              item={item}
              active={active}
              onActivate={() => activatePack(item.ref)}
              onFork={() => setForkDraft({
                  source: item.ref,
                  id: `${item.ref.id}.fork`,
                  name: `${item.pack.metadata.name} Fork`,
                  version: '1.0.0',
                  author: 'Member',
                })}
              onExport={() => exportPack(item.ref.id, item.ref.version)}
              onUninstall={() => {
                try {
                  store.uninstall(item.ref);
                  setMessage(active
                    ? `Removed ${item.pack.metadata.name}; the default pack is now active.`
                    : `Removed ${item.pack.metadata.name}.`);
                  setRevision((value) => value + 1);
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : 'Workspace Pack could not be uninstalled.');
                }
              }}
            >
              {item.pack.metadata.name}
            </WorkspacePackCard>
          );
        })}
      </ul>
      {forkDraft !== null && (
        <fieldset className="workspace-pack-fork" aria-label="Workspace Pack fork form">
          <legend>Create a reusable copy</legend>
          <p>Give this copy its own identity. The original setup stays unchanged.</p>
          <div className="workspace-pack-fork__fields">
            {(['id', 'name', 'version', 'author'] as const).map((field) => (
              <label className="mock-field" key={field}>
                <span>{field === 'id' ? 'Pack ID' : field[0]!.toUpperCase() + field.slice(1)}</span>
                <input
                  required
                  value={forkDraft[field]}
                  onChange={(event) => setForkDraft({ ...forkDraft, [field]: event.currentTarget.value })}
                />
              </label>
            ))}
          </div>
          <div className="workspace-pack-fork__actions">
            <button className="mock-btn mock-btn-primary" type="button" onClick={materializeFork}>Create fork</button>
            <button className="mock-btn mock-btn-ghost" type="button" onClick={() => setForkDraft(null)}>Cancel fork</button>
          </div>
        </fieldset>
      )}
    </section>
  );
}

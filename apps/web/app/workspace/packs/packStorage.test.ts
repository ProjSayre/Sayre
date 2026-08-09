import { describe, expect, it } from 'vitest';
import type { WorkspacePackDocument } from '../../../../../packages/workspace-packs/src/runtime';
import { defaultWorkspacePack } from './builtins';
import { createBrowserWorkspacePackStore } from './packStorage';
import { workspaceComponentCatalog } from './runtimeCatalog';

class FailableStorage implements Storage {
  private readonly values = new Map<string, string>();
  failNextWrite = false;
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('quota exceeded');
    }
    this.values.set(key, value);
  }
}

function importedDocument(): WorkspacePackDocument {
  const pack = structuredClone(defaultWorkspacePack.pack);
  return {
    ...pack,
    metadata: { ...pack.metadata, id: 'sayre.atomic-test', version: '1.0.0', name: 'Atomic test' },
  };
}

function createStore(storage: Storage) {
  return createBrowserWorkspacePackStore({
    builtins: [defaultWorkspacePack],
    storage,
    catalog: workspaceComponentCatalog,
    now: () => new Date('2026-08-06T00:00:00.000Z'),
  });
}

describe('Workspace Pack browser transaction and revision storage', () => {
  // @spec AC-31 AC-35 EC-28 EC-29 EC-32
  it('keeps the active import intact when atomic uninstall persistence fails', () => {
    const storage = new FailableStorage();
    const store = createStore(storage);
    const imported = importedDocument();
    expect(store.install(JSON.stringify(imported)).ok).toBe(true);
    const ref = { id: imported.metadata.id, version: imported.metadata.version };
    store.activate(ref);
    storage.failNextWrite = true;
    expect(() => store.uninstall(ref)).toThrow(/quota/i);
    expect(store.active()).toEqual(ref);
    expect(store.get(ref)).not.toBeNull();

    store.uninstall(ref);
    expect(store.active()).toEqual(defaultWorkspacePack.ref);
    expect(store.get(ref)).toBeNull();
    expect(store.recoveryMessage()).toMatch(/default pack is now active/i);
  });

  // @spec AC-35 EC-27
  it('reports corrupt persisted state while retaining built-ins', () => {
    const storage = new FailableStorage();
    storage.setItem('sayre.workspace-packs.state.v1', '{not-json');
    const store = createStore(storage);
    expect(store.list()).toHaveLength(1);
    expect(store.active()).toEqual(defaultWorkspacePack.ref);
    expect(store.recoveryMessage()).toMatch(/corrupt|invalid/i);
  });

  // @spec AC-59 EC-58
  it('rejects a stale personal-override revision instead of overwriting it', () => {
    const store = createStore(new FailableStorage());
    const revision = store.personalOverrideRevision(defaultWorkspacePack.ref);
    store.savePersonalOverride(defaultWorkspacePack.ref, { defaultViewId: 'product' }, revision);
    expect(() => store.savePersonalOverride(
      defaultWorkspacePack.ref,
      { defaultViewId: 'technical' },
      revision,
    )).toThrow(/revision|conflict/i);
    expect(store.personalOverride(defaultWorkspacePack.ref)).toEqual({ defaultViewId: 'product' });
  });

  // @spec AC-31 EC-32
  it('does not claim an active-pack fallback when removing an inactive import', () => {
    const store = createStore(new FailableStorage());
    const imported = importedDocument();
    expect(store.install(JSON.stringify(imported)).ok).toBe(true);
    store.uninstall({ id: imported.metadata.id, version: imported.metadata.version });
    expect(store.active()).toEqual(defaultWorkspacePack.ref);
    expect(store.recoveryMessage()).toBeNull();
  });

  // @spec AC-59 EC-66
  it('commits fork registration and activation in one storage transaction', () => {
    const storage = new FailableStorage();
    const store = createStore(storage);
    const identity = { id: 'sayre.transaction-fork', name: 'Transaction fork', version: '1.0.0', author: 'Tester' };
    storage.failNextWrite = true;
    expect(() => store.forkAndActivate(defaultWorkspacePack.ref, identity, defaultWorkspacePack.pack)).toThrow(/quota/i);
    expect(store.get({ id: identity.id, version: identity.version })).toBeNull();
    expect(store.active()).toEqual(defaultWorkspacePack.ref);

    const installed = store.forkAndActivate(defaultWorkspacePack.ref, identity, defaultWorkspacePack.pack);
    expect(store.get(installed.ref)).not.toBeNull();
    expect(store.active()).toEqual(installed.ref);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type JsonRecord = Record<string, unknown>;

interface PackStore {
  list(): JsonRecord[];
  get(ref: JsonRecord): JsonRecord | null;
  install(rawJson: string): JsonRecord;
  fork(source: JsonRecord, identity: JsonRecord): JsonRecord;
  uninstall(ref: JsonRecord): void;
  active(): JsonRecord;
  activate(ref: JsonRecord): void;
  preferences(ref: JsonRecord, layoutId: string): JsonRecord | null;
  savePreferences(preferences: JsonRecord): void;
  personalOverride(ref: JsonRecord): JsonRecord | null;
  savePersonalOverride(ref: JsonRecord, override: JsonRecord): void;
  resetPersonalOverride(ref: JsonRecord): void;
  export(ref: JsonRecord): string;
  subscribe(listener: () => void): () => void;
}

interface StorageModule {
  createBrowserWorkspacePackStore(input: JsonRecord): PackStore;
}

interface CliModule {
  runWorkspacePackCli(argv: string[], io?: JsonRecord): Promise<number>;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'apps/web/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

async function loadStorage(): Promise<StorageModule> {
  const expected = resolve(
    repositoryRoot(),
    'apps/web/app/workspace/packs/packStorage.ts',
  );
  expect(existsSync(expected), 'Workspace Pack browser storage is not implemented yet.').toBe(true);
  return vi.importActual<StorageModule>('./packs/packStorage');
}

async function loadCli(): Promise<CliModule> {
  const expected = resolve(repositoryRoot(), 'packages/workspace-packs/src/index.ts');
  expect(existsSync(expected), 'Workspace Pack CLI is not implemented yet.').toBe(true);
  return vi.importActual<CliModule>('../../../../packages/workspace-packs/src/index');
}

function builtIn(name: 'default' | 'pitch' = 'default'): JsonRecord {
  const path = resolve(
    repositoryRoot(),
    `apps/web/workspace-packs/${name}/sayre.workspace.json`,
  );
  expect(existsSync(path), `${name} built-in Workspace Pack is missing.`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
}

function installed(pack: JsonRecord, source: 'builtin' | 'imported' | 'forked' = 'builtin'): JsonRecord {
  const metadata = pack.metadata as JsonRecord;
  return {
    ref: { id: metadata.id, version: metadata.version },
    source,
    installedAt: '2026-08-06T00:00:00.000Z',
    pack,
  };
}

function catalogFixture(): JsonRecord {
  return {
    runtimeContractVersion: 1,
    components: [
      { id: 'sayre.primary-surface', version: 1, allowedSlots: ['primary'], requiredCapabilities: ['sayre.technical'], minimumRole: null },
      { id: 'sayre.explorer', version: 1, allowedSlots: ['explorer', 'navigation'], requiredCapabilities: ['sayre.technical'], minimumRole: null },
      { id: 'sayre.inspector', version: 1, allowedSlots: ['inspector'], requiredCapabilities: ['sayre.technical'], minimumRole: null },
    ],
    capabilities: [
      { id: 'sayre.technical', version: 1 },
      { id: 'sayre.product', version: 1 },
    ],
  };
}

describe('Workspace Pack storage, sharing, CLI, and authoring — leading red', () => {
  // @spec AC-29 AC-30 AC-31 AC-35 EC-27 EC-28 EC-30 EC-31 EC-32 EC-40
  it('keeps built-ins immutable, pins versions, validates every storage read, and recovers atomically', async () => {
    const { createBrowserWorkspacePackStore } = await loadStorage();
    const storage = new MemoryStorage();
    const defaultPack = builtIn('default');
    const store = createBrowserWorkspacePackStore({
      builtins: [installed(defaultPack)],
      storage,
      catalog: catalogFixture(),
      now: () => new Date('2026-08-06T00:00:00.000Z'),
    });
    const defaultRef = installed(defaultPack).ref as JsonRecord;
    expect(store.active()).toEqual(defaultRef);
    expect(() => store.uninstall(defaultRef)).toThrow();

    const imported = structuredClone(defaultPack);
    (imported.metadata as JsonRecord).id = 'coworker.workspace';
    (imported.metadata as JsonRecord).version = '1.0.0';
    expect(store.install(JSON.stringify(imported)).ok).toBe(true);
    expect(store.install(JSON.stringify(imported)).ok).toBe(true);
    const conflict = structuredClone(imported);
    (conflict.metadata as JsonRecord).description = 'different content';
    expect((store.install(JSON.stringify(conflict)) as JsonRecord).ok).toBe(false);
    expect(store.active()).toEqual(defaultRef);
  });

  // @spec AC-32 AC-33 AC-36 AC-59 AC-60 EC-29 EC-34 EC-41 EC-57 EC-58 EC-64 EC-66
  it('separates preferences/overrides from canonical exports and materializes only explicit forks', async () => {
    const { createBrowserWorkspacePackStore } = await loadStorage();
    const storage = new MemoryStorage();
    const pack = builtIn('default');
    const ref = installed(pack).ref as JsonRecord;
    const store = createBrowserWorkspacePackStore({
      builtins: [installed(pack)], storage, catalog: catalogFixture(),
      now: () => new Date('2026-08-06T00:00:00.000Z'),
    });
    store.savePreferences({
      pack: ref, layoutId: 'layout.default', regionSizes: { 'region.explorer': 333 },
      collapsedRegionIds: ['region.inspector'], updatedAt: '2026-08-06T00:00:00.000Z',
    });
    store.savePersonalOverride(ref, { defaultViewId: 'product' });
    expect(store.personalOverride(ref)).toEqual({ defaultViewId: 'product' });
    const exported = store.export(ref);
    expect(exported).not.toContain('regionSizes');
    expect(exported).not.toContain('collapsedRegionIds');
    expect(exported).not.toContain('personalOverride');

    const fork = store.fork(ref, {
      id: 'sayre.personal', name: 'Personal', version: '1.0.0', author: 'Member',
    });
    expect((fork.ref as JsonRecord).id).toBe('sayre.personal');
    expect(((fork.pack as JsonRecord).metadata as JsonRecord).derivedFrom).toEqual(ref);
    expect(store.get(ref)?.pack).toEqual(pack);
  });

  // @spec AC-34 EC-1 EC-33 EC-44 EC-45
  it('accepts only installed exact pack references in URL state and preserves explicit authorized navigation', async () => {
    const registryPath = resolve(
      repositoryRoot(),
      'apps/web/app/workspace/packs/packRegistry.ts',
    );
    expect(existsSync(registryPath), 'Pack-reference resolution is not implemented yet.').toBe(true);
    const registry = await vi.importActual<Record<string, (...args: unknown[]) => unknown>>(
      './packs/packRegistry',
    );
    expect(typeof registry.resolveWorkspacePackReference).toBe('function');
    const result = registry.resolveWorkspacePackReference(
      'sayre.default@1.0.0',
      [installed(builtIn('default'))],
    ) as JsonRecord;
    expect(result.ok).toBe(true);
    for (const unsafe of ['https://bad.example/p.json', '{"theme":{}}', '../pack', 'sayre.default']) {
      expect((registry.resolveWorkspacePackReference(unsafe, []) as JsonRecord).ok).toBe(false);
    }
  });

  // @spec AC-37 AC-38 AC-39 AC-40 AC-49 EC-35 EC-36 EC-37 EC-38
  it('provides deterministic atomic CLI commands with parseable JSON failures and safe roots', async () => {
    const { runWorkspacePackCli } = await loadCli();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writes: Array<{ path: string; value: string }> = [];
    const code = await runWorkspacePackCli(['catalog', '--json'], {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      readFile: async () => JSON.stringify(builtIn('default')),
      writeFileAtomic: async (path: string, value: string) => { writes.push({ path, value }); },
      mkdir: async () => undefined,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ command: 'catalog', ok: true });
    expect(stderr).toEqual([]);
    expect(writes).toEqual([]);

    const rootPackage = JSON.parse(
      readFileSync(resolve(repositoryRoot(), 'package.json'), 'utf8'),
    ) as JsonRecord;
    expect((rootPackage.scripts as JsonRecord)['workspace-pack']).toBeTruthy();
    expect(existsSync(resolve(repositoryRoot(), 'packages/workspace-packs/package.json'))).toBe(true);
  });

  // @spec AC-41 AC-42 AC-47 AC-48 EC-39 EC-67
  it('documents a semantic-only authoring sequence and stops at trusted catalog extension', () => {
    const guidePath = resolve(repositoryRoot(), 'docs/workspace-pack-authoring.md');
    const packDocPath = resolve(repositoryRoot(), 'docs/workspace-packs.md');
    const skillPath = resolve(
      repositoryRoot(),
      '.claude/skills/workspace-pack-author/SKILL.md',
    );
    for (const path of [guidePath, packDocPath, skillPath]) expect(existsSync(path)).toBe(true);
    const guide = readFileSync(guidePath, 'utf8');
    expect(guide).toMatch(/inspect[\s\S]*catalog[\s\S]*dry-run[\s\S]*validate[\s\S]*diff[\s\S]*preview/i);
    expect(guide).toMatch(/trusted.catalog.extension/i);
    expect(guide).toMatch(/do not[\s\S]*(tsx|css|authentication|graph|low-level patch)/i);
  });

  // @spec AC-64 AC-65 AC-66 AC-67 EC-68
  it('keeps LLM work behind the visual-editor gate and records reproducible R&D evidence without product exposure', () => {
    const reportPath = resolve(repositoryRoot(), 'docs/workspace-pack-llm-rd.md');
    expect(existsSync(reportPath), 'The post-editor LLM R&D assessment does not exist yet.').toBe(true);
    const report = readFileSync(reportPath, 'utf8');
    for (const phrase of [
      'layout move', 'replacement', 'hide', 'resize', 'theme', 'default view',
      'malicious', 'ambiguous', 'validator', 'human correction', 'repeat',
      'visual-editor gate', 'not production',
    ]) expect(report.toLowerCase()).toContain(phrase);

    const productFiles = [
      resolve(repositoryRoot(), 'apps/web/app/page.tsx'),
      resolve(repositoryRoot(), 'apps/web/app/workspace/components/WorkspaceShell.tsx'),
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(productFiles).not.toMatch(/prompt.*workspace|llm.*author|autonomous.*pack/i);
  });
});

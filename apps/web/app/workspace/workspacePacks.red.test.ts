import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type JsonRecord = Record<string, unknown>;

interface WorkspacePackModule {
  WORKSPACE_PACK_SCHEMA_VERSION: number;
  WORKSPACE_RUNTIME_CONTRACT_VERSION: number;
  parseWorkspacePack(value: unknown): JsonRecord;
  validateWorkspacePackCompatibility(pack: JsonRecord, catalog: JsonRecord): JsonRecord;
  resolveWorkspaceExperience(input: JsonRecord): JsonRecord;
  canonicalizeWorkspacePack(pack: JsonRecord): string;
  applyWorkspaceEditOperation(pack: JsonRecord, operation: JsonRecord, context: JsonRecord): JsonRecord;
  applyWorkspaceEditOperations(pack: JsonRecord, operations: JsonRecord[], context: JsonRecord): JsonRecord;
  applyWorkspacePackPatch(pack: JsonRecord, operations: JsonRecord[], catalog: JsonRecord): JsonRecord;
  diffWorkspacePacks(before: JsonRecord, after: JsonRecord): JsonRecord[];
}

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'apps/web/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

async function loadWorkspacePacks(): Promise<WorkspacePackModule> {
  const expected = resolve(repositoryRoot(), 'packages/workspace-packs/src/index.ts');
  expect(
    existsSync(expected),
    'The reviewed Workspace Pack contract has not been implemented yet.',
  ).toBe(true);
  return vi.importActual<WorkspacePackModule>(
    '../../../../packages/workspace-packs/src/index',
  );
}

export function makeTheme(accent = '#5A6CFF'): JsonRecord {
  return {
    colors: {
      canvas: '#111111',
      raised: '#1A1A1A',
      hover: '#242424',
      border: '#333333',
      borderStrong: '#444444',
      edge: '#666666',
      node: '#777777',
      textFaint: '#888888',
      textMuted: '#AAAAAA',
      text: '#DDDDDD',
      textStrong: '#FFFFFF',
      accent,
      accentText: '#FFFFFF',
      accentContent: '#BFC6FF',
      warning: '#FFB020',
      danger: '#FF4D4F',
    },
    typography: { ui: 'sayre-grotesk', mono: 'system-mono' },
    density: 'comfortable',
    radius: 'subtle',
  };
}

export function makePack(overrides: JsonRecord = {}): JsonRecord {
  const pack: JsonRecord = {
    schemaVersion: 1,
    metadata: {
      id: 'sayre.default',
      name: 'Sayre Default',
      version: '1.0.0',
      description: 'Default product workspace',
      author: 'Sayre',
      license: 'Proprietary',
      tags: ['default'],
      derivedFrom: null,
    },
    compatibility: {
      schemaVersion: 1,
      minimumRuntimeContractVersion: 1,
      maximumRuntimeContractVersion: null,
      requiredComponents: [
        { id: 'sayre.primary-surface', version: 1 },
        { id: 'sayre.explorer', version: 1 },
        { id: 'sayre.inspector', version: 1 },
      ],
      requiredCapabilities: ['sayre.technical'],
    },
    theme: makeTheme(),
    defaultLayoutId: 'layout.default',
    defaultViewId: 'technical',
    layouts: [
      {
        id: 'layout.default',
        regions: [
          {
            id: 'region.explorer',
            slot: 'explorer',
            component: { id: 'sayre.explorer', version: 1 },
            order: 0,
            hidden: false,
            defaultSize: 280,
            minimumSize: 180,
            maximumSize: 480,
            resize: 'horizontal',
            collapsible: true,
            defaultCollapsed: false,
            visibleInViews: null,
            compactBehavior: 'collapse',
          },
          {
            id: 'region.primary',
            slot: 'primary',
            component: { id: 'sayre.primary-surface', version: 1 },
            order: 0,
            hidden: false,
            defaultSize: 800,
            minimumSize: 320,
            maximumSize: 2400,
            resize: 'none',
            collapsible: false,
            defaultCollapsed: false,
            visibleInViews: null,
            compactBehavior: 'keep',
          },
          {
            id: 'region.inspector',
            slot: 'inspector',
            component: { id: 'sayre.inspector', version: 1 },
            order: 0,
            hidden: false,
            defaultSize: 360,
            minimumSize: 240,
            maximumSize: 640,
            resize: 'horizontal',
            collapsible: true,
            defaultCollapsed: false,
            visibleInViews: null,
            compactBehavior: 'overlay',
          },
        ],
      },
    ],
    views: [
      {
        id: 'technical',
        label: 'Technical',
        glyph: 'T',
        hint: 'Technical repository view',
        capability: 'sayre.technical',
        surface: { id: 'sayre.primary-surface', version: 1 },
        toolbar: [],
        inspectorModules: [],
        enabled: true,
      },
      {
        id: 'product',
        label: 'Product',
        glyph: 'P',
        hint: 'Product feature view',
        capability: 'sayre.product',
        surface: { id: 'sayre.primary-surface', version: 1 },
        toolbar: [],
        inspectorModules: [],
        enabled: true,
      },
    ],
    settingsOrder: ['workspace-packs'],
  };
  return { ...pack, ...overrides };
}

export function makeCatalog(): JsonRecord {
  return {
    runtimeContractVersion: 1,
    components: [
      {
        id: 'sayre.primary-surface',
        version: 1,
        allowedSlots: ['primary'],
        requiredCapabilities: ['sayre.technical'],
        minimumRole: null,
      },
      {
        id: 'sayre.explorer',
        version: 1,
        allowedSlots: ['explorer', 'navigation'],
        requiredCapabilities: ['sayre.technical'],
        minimumRole: null,
      },
      {
        id: 'sayre.inspector',
        version: 1,
        allowedSlots: ['inspector'],
        requiredCapabilities: ['sayre.technical'],
        minimumRole: null,
      },
      {
        id: 'sayre.admin-settings',
        version: 1,
        allowedSlots: ['overlay'],
        requiredCapabilities: [],
        minimumRole: 'admin',
      },
    ],
    capabilities: [
      { id: 'sayre.technical', version: 1 },
      { id: 'sayre.product', version: 1 },
    ],
  };
}

function expectFailure(result: JsonRecord, pathFragment?: string): void {
  expect(result.ok).toBe(false);
  const violations = result.violations as JsonRecord[];
  expect(Array.isArray(violations)).toBe(true);
  expect(violations.length).toBeGreaterThan(0);
  if (pathFragment !== undefined) {
    expect(violations.some((item) => String(item.path).includes(pathFragment))).toBe(true);
  }
}

describe('Workspace Pack shared contract — leading red', () => {
  // @spec AC-2 EC-40 EC-50
  it('exposes schema/runtime version 1 and can parse both first-party packs without browser globals', async () => {
    const core = await loadWorkspacePacks();
    expect(core.WORKSPACE_PACK_SCHEMA_VERSION).toBe(1);
    expect(core.WORKSPACE_RUNTIME_CONTRACT_VERSION).toBe(1);
    for (const name of ['default', 'pitch']) {
      const path = resolve(
        repositoryRoot(),
        `apps/web/workspace-packs/${name}/sayre.workspace.json`,
      );
      expect(existsSync(path)).toBe(true);
    }
  });

  // @spec AC-3 AC-4 AC-16 AC-50 EC-2 EC-3 EC-4 EC-5 EC-6 EC-7 EC-13 EC-14 EC-15 EC-16 EC-49
  it('strictly rejects malformed, oversized, executable, unknown, duplicate, and unsafe pack values with paths', async () => {
    const core = await loadWorkspacePacks();
    for (const invalid of [null, [], 'not a document', 42, { unknown: true }]) {
      expectFailure(core.parseWorkspacePack(invalid), '');
    }

    const unsafeCases: JsonRecord[] = [
      { ...makePack(), unexpected: true },
      { ...makePack(), schemaVersion: 2 },
      { ...makePack(), theme: { ...makeTheme(), colors: { ...(makeTheme().colors as JsonRecord), accent: 'url(https://bad.example)' } } },
      { ...makePack(), metadata: { ...(makePack().metadata as JsonRecord), id: '../escape' } },
      { ...makePack(), metadata: { ...(makePack().metadata as JsonRecord), description: '   ' } },
    ];
    for (const invalid of unsafeCases) expectFailure(core.parseWorkspacePack(invalid));

    const polluted = JSON.parse('{"schemaVersion":1,"__proto__":{"polluted":true}}');
    expectFailure(core.parseWorkspacePack(polluted));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  // @spec AC-5 AC-6 EC-8 EC-11 EC-12
  it('uses closed component/capability metadata and refuses unknown, incompatible, or role-ineligible references', async () => {
    const core = await loadWorkspacePacks();
    const catalog = makeCatalog();
    const valid = core.validateWorkspacePackCompatibility(makePack(), catalog);
    expect(valid.ok).toBe(true);

    const unknown = makePack({
      compatibility: {
        ...(makePack().compatibility as JsonRecord),
        requiredComponents: [{ id: 'remote.component', version: 1 }],
      },
    });
    expectFailure(core.validateWorkspacePackCompatibility(unknown, catalog));

    const adminRegion = {
      ...makePack(),
      layouts: [{
        id: 'layout.default',
        regions: [
          ...((makePack().layouts as JsonRecord[])[0].regions as JsonRecord[]),
          {
            id: 'region.admin', slot: 'overlay', order: 0, hidden: false,
            component: { id: 'sayre.admin-settings', version: 1 },
            defaultSize: 320, minimumSize: 240, maximumSize: 480,
            resize: 'none', collapsible: true, defaultCollapsed: true,
            visibleInViews: null, compactBehavior: 'overlay',
          },
        ],
      }],
    };
    const resolved = core.resolveWorkspaceExperience({
      safetyDefaults: makePack(), selectedPack: adminRegion,
      organizationOverride: null, userOverride: null, userPreferences: null,
      catalog, viewportClass: 'wide', role: 'member',
    });
    expect(JSON.stringify(resolved)).not.toContain('sayre.admin-settings');
  });

  // @spec AC-7 AC-8 EC-1 EC-9 EC-10 EC-26
  it('resolves layers deterministically, clamps preferences, and falls back for structurally unusable packs', async () => {
    const core = await loadWorkspacePacks();
    const input: JsonRecord = {
      safetyDefaults: makePack(),
      selectedPack: makePack({ theme: makeTheme('#1111AA') }),
      organizationOverride: { theme: makeTheme('#2222BB') },
      userOverride: { theme: makeTheme('#3333CC') },
      userPreferences: {
        pack: { id: 'sayre.default', version: '1.0.0' },
        layoutId: 'layout.default',
        regionSizes: { 'region.explorer': 9999 },
        collapsedRegionIds: ['region.inspector'],
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      catalog: makeCatalog(), viewportClass: 'wide', role: 'member',
    };
    const first = core.resolveWorkspaceExperience(input);
    const second = core.resolveWorkspaceExperience(structuredClone(input));
    expect(first).toEqual(second);
    expect(((first.theme as JsonRecord).colors as JsonRecord).accent).toBe('#3333CC');
    const regions = (first.layout as JsonRecord).regions as JsonRecord[];
    expect(regions.find((region) => region.id === 'region.explorer')?.size).toBe(480);
    expect(regions.find((region) => region.id === 'region.inspector')?.collapsed).toBe(true);

    const invalid = makePack({ layouts: [{ id: 'layout.default', regions: [] }] });
    const fallback = core.resolveWorkspaceExperience({ ...input, selectedPack: invalid });
    expect(fallback.usedSafetyFallback).toBe(true);
    expect((fallback.pack as JsonRecord).id).toBe('sayre.default');
  });

  // @spec AC-15 AC-32 AC-33 EC-34
  it('canonicalizes valid six/eight-digit colors deterministically across export-shaped round trips', async () => {
    const core = await loadWorkspacePacks();
    for (const accent of ['#123ABC', '#123ABC80']) {
      const result = core.parseWorkspacePack(makePack({ theme: makeTheme(accent) }));
      expect(result.ok).toBe(true);
      const canonical = core.canonicalizeWorkspacePack(result.pack as JsonRecord);
      expect(canonical).toBe(core.canonicalizeWorkspacePack(JSON.parse(canonical)));
      expect(canonical).toContain(accent);
    }
  });

  // @spec AC-17 AC-57 AC-62 EC-51 EC-52 EC-55 EC-59 EC-65
  it('applies only compatible semantic edits, preserves the original on failure, and is atomic for ordered batches', async () => {
    const core = await loadWorkspacePacks();
    const pack = makePack();
    const context = {
      catalog: makeCatalog(), role: 'member',
      availableCapabilities: ['sayre.technical', 'sayre.product'],
    };
    const move = {
      type: 'move-region', layoutId: 'layout.default',
      regionId: 'region.explorer', slot: 'navigation', order: 0,
    };
    const moved = core.applyWorkspaceEditOperation(pack, move, context);
    expect(moved.ok).toBe(true);
    expect(pack).toEqual(makePack());

    const forbidden = core.applyWorkspaceEditOperation(
      pack,
      { type: 'set-region-hidden', layoutId: 'layout.default', regionId: 'region.primary', hidden: true },
      context,
    );
    expectFailure(forbidden);
    expect(forbidden.pack).toEqual(pack);

    const batch = core.applyWorkspaceEditOperations(pack, [
      move,
      { type: 'resize-region-default', layoutId: 'layout.default', regionId: 'missing', size: Number.NaN },
    ], context);
    expectFailure(batch);
    expect(batch.pack).toEqual(pack);
  });

  // @spec AC-38 AC-46 EC-5 EC-36 EC-37
  it('applies the allowed patch subset atomically and reports no-op patches without rewriting semantics', async () => {
    const core = await loadWorkspacePacks();
    const pack = makePack();
    const noOp = core.applyWorkspacePackPatch(
      pack,
      [{ op: 'replace', path: '/metadata/name', value: 'Sayre Default' }],
      makeCatalog(),
    );
    expect(noOp.changedPaths).toEqual([]);

    for (const path of [
      '/metadata/id', '/__proto__/polluted', '/constructor/value', '/layouts/99', '/bad-root',
    ]) {
      expect(() => core.applyWorkspacePackPatch(
        pack,
        [{ op: 'replace', path, value: 'unsafe' }],
        makeCatalog(),
      )).toThrow();
      expect(pack).toEqual(makePack());
    }
  });
});

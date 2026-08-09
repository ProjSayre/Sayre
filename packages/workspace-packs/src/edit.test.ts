import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyWorkspaceEditOperation, applyWorkspaceEditOperations } from './edit';
import { canonicalizeWorkspacePack } from './canonicalize';
import { parseWorkspacePack } from './parse';
import type { WorkspaceEditOperation } from './contracts';
import { testCatalog, testPack } from './testFixture';

const context = { catalog: testCatalog, role: 'member' as const, availableCapabilities: testCatalog.capabilities.map((item) => item.id) };

describe('semantic workspace editing', () => {
  // @spec AC-17 AC-57 AC-62 AC-63
  it('applies approved operations without changing the base', () => {
    const base = testPack();
    const result = applyWorkspaceEditOperation(base, { type: 'set-theme-color', token: 'accent', value: '#ABCDEF' }, context);
    expect(result.ok).toBe(true);
    expect(base.theme.colors.accent).not.toBe('#ABCDEF');
  });

  it('returns the original document when an ordered batch fails', () => {
    const base = testPack();
    const result = applyWorkspaceEditOperations(base, [
      { type: 'set-default-view', viewId: 'product' },
      { type: 'resize-region-default', layoutId: 'layout.default', regionId: 'region.explorer', size: -1 },
    ], context);
    expect(result.ok).toBe(false);
    expect(result.pack).toEqual(base);
  });

  it('reproduces the checked-in pitch pack through semantic operations', () => {
    const operations = JSON.parse(readFileSync(new URL('../../../apps/web/workspace-packs/pitch/from-default.operations.json', import.meta.url), 'utf8')) as WorkspaceEditOperation[];
    const pitchResult = parseWorkspacePack(JSON.parse(readFileSync(new URL('../../../apps/web/workspace-packs/pitch/sayre.workspace.json', import.meta.url), 'utf8')));
    if (!pitchResult.ok) throw new Error('Pitch fixture is invalid.');
    const edited = applyWorkspaceEditOperations(testPack(), operations, context);
    if (!edited.ok) throw new Error(edited.violations.map((item) => item.message).join('; '));
    const withIdentity = {
      ...edited.pack,
      metadata: pitchResult.pack.metadata,
    };
    expect(canonicalizeWorkspacePack(withIdentity)).toBe(canonicalizeWorkspacePack(pitchResult.pack));
  });

  // @spec AC-52 EC-51
  it('treats a move to the current position as a no-op', () => {
    const base = testPack();
    const explorer = base.layouts[0]!.regions.find((region) => region.id === 'region.explorer')!;
    const result = applyWorkspaceEditOperation(base, {
      type: 'move-region',
      layoutId: base.defaultLayoutId,
      regionId: explorer.id,
      slot: explorer.slot,
      order: explorer.order,
    }, context);
    expect(result).toMatchObject({ ok: true, changedPaths: [] });
    expect(result.pack).toBe(base);
  });

  // @spec AC-54 EC-55 EC-63
  it('rejects a replacement that exceeds the current role or active capabilities', () => {
    const base = testPack();
    const restrictedCatalog = {
      ...testCatalog,
      components: [
        ...testCatalog.components,
        {
          id: 'sayre.restricted',
          version: 1,
          allowedSlots: ['explorer' as const],
          requiredCapabilities: ['sayre.restricted'],
          minimumRole: 'admin' as const,
        },
      ],
    };
    const result = applyWorkspaceEditOperation(base, {
      type: 'replace-region-component',
      layoutId: base.defaultLayoutId,
      regionId: 'region.explorer',
      component: { id: 'sayre.restricted', version: 1 },
    }, { catalog: restrictedCatalog, role: 'member', availableCapabilities: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]).toMatchObject({ code: 'component-incompatible' });
    expect(result.pack).toBe(base);
  });
});

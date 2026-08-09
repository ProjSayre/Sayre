import { describe, expect, it } from 'vitest';
import { resolveWorkspaceExperience } from './resolve';
import { testCatalog, testPack } from './testFixture';

describe('Workspace Pack resolution', () => {
  // @spec AC-7 AC-8 AC-22
  it('clamps exact-version preferences and preserves one primary region', () => {
    const pack = testPack();
    const result = resolveWorkspaceExperience({
      safetyDefaults: pack, selectedPack: pack, organizationOverride: null, userOverride: null,
      userPreferences: {
        pack: { id: pack.metadata.id, version: pack.metadata.version }, layoutId: pack.defaultLayoutId,
        regionSizes: { 'region.explorer': 99_999 }, collapsedRegionIds: [], updatedAt: '2026-08-06T00:00:00.000Z',
      },
      catalog: testCatalog, viewportClass: 'wide', role: 'member',
    });
    expect(result.layout.regions.find((item) => item.id === 'region.explorer')?.size).toBe(480);
    expect(result.layout.regions.filter((item) => item.slot === 'primary')).toHaveLength(1);
  });

  // @spec AC-5 EC-11 EC-16 EC-45
  it('treats undeclared view capabilities as optional and filters unavailable views', () => {
    const pack = structuredClone(testPack());
    pack.views = [...pack.views, {
      ...pack.views[0],
      id: 'optional-view',
      label: 'Optional',
      capability: 'sayre.optional',
    }];
    const result = resolveWorkspaceExperience({
      safetyDefaults: pack,
      selectedPack: pack,
      organizationOverride: null,
      userOverride: null,
      userPreferences: null,
      catalog: testCatalog,
      viewportClass: 'wide',
      role: 'member',
    });
    expect(result.views.find((view) => view.id === 'optional-view')).toMatchObject({
      available: false,
      unavailableReason: 'Capability unavailable',
    });
  });
});

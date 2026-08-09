import { describe, expect, it } from 'vitest';
import { parseWorkspacePack, validateWorkspacePackCompatibility } from './parse';
import { testCatalog, testPack } from './testFixture';

describe('Workspace Pack parsing', () => {
  // @spec AC-2 AC-3 AC-4 AC-16 AC-50
  it('parses the default pack and validates its trusted references', () => {
    expect(parseWorkspacePack(testPack()).ok).toBe(true);
    expect(validateWorkspacePackCompatibility(testPack(), testCatalog).ok).toBe(true);
  });

  // @spec AC-3 AC-4 EC-4 EC-15
  it('rejects unknown and unsafe values with a path', () => {
    const candidate = { ...testPack(), script: 'alert(1)' };
    const result = parseWorkspacePack(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.some((item) => item.path === '/script')).toBe(true);
  });

  // @spec AC-3 EC-6 EC-15
  it('enforces the component-prop budget across the complete document', () => {
    const candidate = structuredClone(testPack());
    const props = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, `value${index}`]));
    candidate.compatibility = {
      ...candidate.compatibility,
      requiredComponents: candidate.compatibility.requiredComponents.map((ref, index) => index === 0 ? { ...ref, props } : ref),
    };
    candidate.layouts = candidate.layouts.map((layout, layoutIndex) => layoutIndex === 0 ? {
      ...layout,
      regions: layout.regions.map((region, regionIndex) => regionIndex === 0 ? { ...region, component: { ...region.component, props } } : region),
    } : layout);
    const result = parseWorkspacePack(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'component-prop-limit' })]));
  });
});

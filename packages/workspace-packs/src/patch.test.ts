import { describe, expect, it } from 'vitest';
import { applyWorkspacePackPatch } from './patch';
import { testCatalog, testPack } from './testFixture';

describe('constrained workspace patches', () => {
  // @spec AC-38 EC-5 EC-36
  it('applies an allowed path and rejects pack identity mutation', () => {
    const result = applyWorkspacePackPatch(testPack(), [{ op: 'replace', path: '/theme/colors/accent', value: '#ABCDEF' }], testCatalog);
    expect(result.pack.theme.colors.accent).toBe('#ABCDEF');
    expect(() => applyWorkspacePackPatch(testPack(), [{ op: 'replace', path: '/metadata/id', value: 'evil.pack' }], testCatalog)).toThrow();
  });
});

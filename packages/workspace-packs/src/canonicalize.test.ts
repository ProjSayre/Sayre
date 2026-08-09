import { describe, expect, it } from 'vitest';
import { canonicalizeWorkspacePack, diffWorkspacePacks } from './canonicalize';
import { testPack } from './testFixture';

describe('canonical Workspace Pack JSON', () => {
  // @spec AC-32 AC-33
  it('is deterministic and reports semantic paths', () => {
    const pack = testPack();
    expect(canonicalizeWorkspacePack(pack)).toBe(canonicalizeWorkspacePack(structuredClone(pack)));
    const changed = structuredClone(pack);
    changed.theme.colors.accent = '#ABCDEF';
    expect(diffWorkspacePacks(pack, changed).map((item) => item.path)).toContain('/theme/colors/accent');
  });
});

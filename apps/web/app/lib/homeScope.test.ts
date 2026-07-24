import { describe, expect, it } from 'vitest';
import { resolveHomeScope } from './homeScope';

const REPOSITORY_ID = '22222222-2222-4222-8222-222222222222';

describe('resolveHomeScope', () => {
  it('accepts only a complete repository and full-ref selection', () => {
    expect(
      resolveHomeScope({
        repoId: REPOSITORY_ID,
        refName: 'refs/heads/feature/provider-state',
      }),
    ).toEqual({
      repositoryId: REPOSITORY_ID,
      refName: 'refs/heads/feature/provider-state',
    });
  });

  it('disables provider-state fetching for absent, partial, array, or malformed scope', () => {
    for (const searchParams of [
      undefined,
      { repoId: REPOSITORY_ID },
      { refName: 'refs/heads/main' },
      { repoId: ['not', 'scalar'], refName: 'refs/heads/main' },
      { repoId: REPOSITORY_ID, refName: 'main' },
      { repoId: 'not-a-uuid', refName: 'refs/heads/main' },
    ]) {
      expect(resolveHomeScope(searchParams).repositoryId).toBeNull();
    }
  });
});

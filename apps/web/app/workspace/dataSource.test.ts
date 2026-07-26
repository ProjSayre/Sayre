import { describe, expect, it } from 'vitest';
import { DEFAULT_REPOSITORY_ID } from '../mock/fixtures';
import { fixtureWorkspaceDataSource } from './dataSource';

describe('fixture MCP credential lifecycle', () => {
  it('preserves the issued credential identity when it is revoked', async () => {
    const issued = await fixtureWorkspaceDataSource.issueMcpKey({
      name: 'Claude Code regression test',
      expiresAt: null,
      grants: [
        {
          repoId: DEFAULT_REPOSITORY_ID,
          branch: 'refs/heads/main',
          pathPrefix: 'apps/web',
        },
      ],
    });

    const revoked = await fixtureWorkspaceDataSource.revokeMcpKey(issued.id);

    expect(revoked).toMatchObject({
      id: issued.id,
      name: issued.name,
      keyPrefix: issued.keyPrefix,
      grants: issued.grants,
      revokedByLabel: 'Alex Kwon',
    });
    expect(revoked.revokedAt).not.toBeNull();

    const settings = await fixtureWorkspaceDataSource.mcpSettings(
      new AbortController().signal,
    );
    expect(settings.keys.filter((key) => key.id === issued.id)).toEqual([
      revoked,
    ]);
  });
});

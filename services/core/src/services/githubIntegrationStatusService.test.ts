import { describe, expect, it, vi } from 'vitest';
import type {
  GitHubIntegrationStatusStore,
  StoredGitHubIntegrationStatus,
} from '../db/githubIntegrationStatusStore';
import { getGitHubIntegrationStatus } from './githubIntegrationStatusService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-26T16:00:00.000Z');

function repository(
  id: string,
  options: {
    defaultBranch?: string | null;
    refName?: string | null;
  } = {},
) {
  return {
    id,
    name: `acme/${id.slice(0, 6)}`,
    defaultBranch:
      options.defaultBranch === undefined ? 'main' : options.defaultBranch,
    refs:
      options.refName === undefined || options.refName === null
        ? []
        : [{ refName: options.refName, updatedAt: NOW }],
    createdAt: new Date('2026-07-26T15:30:00.000Z'),
  };
}

describe('GitHub integration status service', () => {
  it('returns a redacted lifecycle for installations and every registered repository', async () => {
    const readyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const preparingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const emptyId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const stored: StoredGitHubIntegrationStatus = {
      installations: [
        {
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          suspendedAt: null,
          revokedAt: null,
          updatedAt: NOW,
        },
        {
          accountLogin: 'old-acme',
          accountType: 'Organization',
          repositorySelection: 'all',
          suspendedAt: null,
          revokedAt: new Date('2026-07-20T10:00:00.000Z'),
          updatedAt: NOW,
        },
      ],
      repositories: [
        repository(readyId, { refName: 'refs/heads/main' }),
        repository(preparingId),
        repository(emptyId, { defaultBranch: null }),
      ],
    };
    const store: GitHubIntegrationStatusStore = {
      get: vi.fn(async () => stored),
    };

    const result = await getGitHubIntegrationStatus(ORG_ID, {
      store,
      now: () => NOW,
    });

    expect(store.get).toHaveBeenCalledWith(ORG_ID);
    expect(result.authorization).toBe('server-filtered');
    expect(result.installations.map(({ state }) => state)).toEqual([
      'active',
      'revoked',
    ]);
    expect(result.repositories.map(({ state }) => state)).toEqual([
      'ready',
      'preparing',
      'empty',
    ]);
    expect(result.repositories[1]).toMatchObject({
      id: preparingId,
      registeredAt: '2026-07-26T15:30:00.000Z',
    });
    expect(result).not.toHaveProperty('orgId');
    expect(result.installations[0]).not.toHaveProperty('installationId');
  });

  it('reports a repository without a graph as preparing', async () => {
    const repositoryId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const store: GitHubIntegrationStatusStore = {
      get: vi.fn(async () => ({
        installations: [],
        repositories: [repository(repositoryId)],
      })),
    };

    const result = await getGitHubIntegrationStatus(ORG_ID, {
      store,
      now: () => NOW,
    });

    expect(result.repositories[0]).toMatchObject({
      id: repositoryId,
      state: 'preparing',
      registeredAt: '2026-07-26T15:30:00.000Z',
    });
  });
});

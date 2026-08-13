import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  RepositoryCatalogStore,
  StoredRepositoryCatalogEntry,
} from '../db/repositoryCatalogStore';
import type {
  PermissionStore,
  ReadScope,
} from '../graph-query/permissions';
import { getRepositoryCatalog } from './repositoryCatalogService';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const REPO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-07-24T18:00:00.000Z');

const MEMBER: AuthContext = {
  subjectType: 'user',
  userId: 'member-a',
  orgId: ORG_A,
  roles: ['member'],
};

const STORED: StoredRepositoryCatalogEntry[] = [
  {
    id: REPO_B,
    name: 'acme/hidden',
    provider: 'github',
    defaultBranch: 'main',
    refs: [{ refName: 'refs/heads/main', updatedAt: NOW }],
  },
  {
    id: REPO_A,
    name: 'acme/visible',
    provider: 'github',
    defaultBranch: 'main',
    refs: [
      { refName: 'refs/heads/release', updatedAt: NOW },
      {
        refName: 'refs/heads/main',
        updatedAt: new Date('2026-07-23T18:00:00.000Z'),
      },
    ],
  },
];

function dependencies(scope: ReadScope) {
  const store: RepositoryCatalogStore = {
    list: vi.fn(async () => STORED),
  };
  const permissions: PermissionStore = {
    getReadScope: vi.fn(async () => scope),
  };
  // W7-01: no sync rows for this pre-existing (non-sync-focused) suite — see
  // repositoryCatalogService.sync.test.ts for the AC-11/AC-12 sync-summary coverage.
  const syncRows = vi.fn(async () => []);
  const now = vi.fn(() => NOW);
  return { store, permissions, syncRows, now };
}

// MEMBER (not admin/owner) -> every admin-gated sync field is null, per AC-12/EC-16.
const IDLE_SYNC = {
  status: 'idle' as const,
  updatedAt: null,
  discoveredRepositories: null,
  registeredRepositories: null,
  revokedRepositories: null,
  sweepOutcome: null,
};

describe('repository catalog service', () => {
  it('uses only the server-derived org and returns the authorized default ref', async () => {
    const deps = dependencies({
      allows: [
        { repoId: REPO_A, branch: 'refs/heads/main', pathPrefix: 'src' },
      ],
      denies: [],
    });

    const result = await getRepositoryCatalog(MEMBER, deps);

    expect(deps.store.list).toHaveBeenCalledWith(ORG_A);
    expect(deps.permissions.getReadScope).toHaveBeenCalledWith(MEMBER);
    expect(result).toEqual({
      authorization: 'server-filtered',
      repositories: [
        {
          id: REPO_A,
          name: 'acme/visible',
          provider: 'github',
          defaultBranch: 'main',
          currentRef: 'refs/heads/main',
          readiness: 'graph_ready',
        },
      ],
      sync: IDLE_SYNC,
    });
  });

  it('hides a repository when a matching deny removes every allowed resource', async () => {
    const deps = dependencies({
      allows: [
        { repoId: REPO_A, branch: null, pathPrefix: null },
        { repoId: REPO_B, branch: null, pathPrefix: null },
      ],
      denies: [
        { repoId: REPO_B, branch: null, pathPrefix: null },
      ],
    });

    const result = await getRepositoryCatalog(MEMBER, deps);

    expect(result.repositories.map((repository) => repository.id)).toEqual([
      REPO_A,
    ]);
  });

  it('marks an authorized but not-yet-ingested repository as registered', async () => {
    const store: RepositoryCatalogStore = {
      list: vi.fn(async () => [{
        id: REPO_A,
        name: 'acme/new',
        provider: 'github',
        defaultBranch: 'main',
        refs: [],
      }]),
    };
    const permissions: PermissionStore = {
      getReadScope: vi.fn(async () => ({
        allows: [{ repoId: REPO_A, branch: null, pathPrefix: null }],
        denies: [],
      })),
    };

    const result = await getRepositoryCatalog(MEMBER, {
      store,
      permissions,
      syncRows: vi.fn(async () => []),
      now: vi.fn(() => NOW),
    });

    expect(result.repositories[0]).toMatchObject({
      currentRef: null,
      readiness: 'registered',
    });
  });
});

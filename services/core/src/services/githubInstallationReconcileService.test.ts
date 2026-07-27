// Fully DI-mocked unit tests for reconcileInstallationRepositories — no Postgres, no
// network. All ReconcileDeps are injected, mirroring the pattern used across the other
// W1-06/W2-09 service test files.

import { describe, expect, it, vi } from 'vitest';
import type { RepoInitialParseEvent } from '@sayre/shared-types';
import type { AuthContext } from '../auth/context';
import type { MessageEnvelope } from '../queue/envelope';
import type { InstalledRepo } from '../github/appClient';
import {
  reconcileInstallationRepositories,
  type ReconcileDeps,
} from './githubInstallationReconcileService';

const SHA_A = 'a'.repeat(40);

function ctx(orgId = 'org-1'): AuthContext {
  return { subjectType: 'user', orgId, userId: 'user-1', roles: ['admin'] };
}

function makeInstalledRepo(overrides: Partial<InstalledRepo> = {}): InstalledRepo {
  return {
    provider_repo_id: '111',
    full_name: 'acme/widgets',
    default_branch: 'main',
    default_branch_head_sha: SHA_A,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }]),
    listOurRepos: vi.fn(async () => []),
    githubClient: {
      authorizeInstallation: vi.fn(),
      mintInstallationToken: vi.fn(),
      listInstallationRepos: vi.fn(async () => [makeInstalledRepo()]),
      getInstallationRepo: vi.fn(),
    },
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    registerRepository: vi.fn(async () => ({ repoId: 'repo-uuid-1' })),
    enqueueInitialParse: vi.fn(async () => undefined),
    kickInitialParseOutbox: vi.fn(),
    ...overrides,
  } as ReconcileDeps;
}

describe('reconcileInstallationRepositories — additive repair (OQ-5: additive-only for MVP)', () => {
  it('an org with zero active installations returns an all-zero result without any network/DB read', async () => {
    const deps = makeDeps({ resolveActiveInstallations: vi.fn(async () => []) });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result).toEqual({ installations: 0, registered: 0, enqueued: 0, revoked: 0, truncated: false });
    expect(deps.listOurRepos).not.toHaveBeenCalled();
    expect(deps.githubClient.listInstallationRepos).not.toHaveBeenCalled();
    expect(deps.withOrg).not.toHaveBeenCalled();
  });

  it('registers and enqueues a repo GitHub reports that we do not hold at all (missed-webhook repair)', async () => {
    const deps = makeDeps({ listOurRepos: vi.fn(async () => []) });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result).toEqual({ installations: 1, registered: 1, enqueued: 1, revoked: 0, truncated: false });
    expect(deps.registerRepository).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-1',
      providerRepoId: '111',
      fullName: 'acme/widgets',
      defaultBranch: 'main',
    });
    expect(deps.enqueueInitialParse).toHaveBeenCalledTimes(1);
    expect(deps.kickInitialParseOutbox).toHaveBeenCalledTimes(1);

    const [, envelope] = (deps.enqueueInitialParse as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      MessageEnvelope<RepoInitialParseEvent>,
    ];
    expect(envelope.source).toBe('github-app-install');
    expect(envelope.payload.reason).toBe('app_install');
  });

  it('registers a repo we hold but as revoked (treats present-but-revoked the same as missing)', async () => {
    const deps = makeDeps({
      listOurRepos: vi.fn(async () => [{ id: 'repo-uuid-1', externalId: '111', revokedAt: new Date() }]),
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result.registered).toBe(1);
    expect(result.enqueued).toBe(1);
  });

  it('does NOT register a repo we already hold active', async () => {
    const deps = makeDeps({
      listOurRepos: vi.fn(async () => [{ id: 'repo-uuid-1', externalId: '111', revokedAt: null }]),
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result).toEqual({ installations: 1, registered: 0, enqueued: 0, revoked: 0, truncated: false });
    expect(deps.registerRepository).not.toHaveBeenCalled();
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
    expect(deps.kickInitialParseOutbox).not.toHaveBeenCalled();
  });

  it('registers but does not enqueue when the GitHub repo has no resolvable HEAD (empty repo)', async () => {
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(async () => [
          makeInstalledRepo({ default_branch: null, default_branch_head_sha: null }),
        ]),
        getInstallationRepo: vi.fn(),
      },
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result.registered).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(deps.kickInitialParseOutbox).not.toHaveBeenCalled();
  });

  it('aggregates across multiple installations with distinct repos, no cross-installation revocation', async () => {
    const deps = makeDeps({
      resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }, { installationId: 777 }]),
      listOurRepos: vi.fn(async () => []),
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(async (installationId: number) =>
          installationId === 555
            ? [makeInstalledRepo({ provider_repo_id: '111', full_name: 'acme/widgets' })]
            : [makeInstalledRepo({ provider_repo_id: '222', full_name: 'acme/gadgets' })],
        ),
        getInstallationRepo: vi.fn(),
      },
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result).toEqual({ installations: 2, registered: 2, enqueued: 2, revoked: 0, truncated: false });
  });

  it('never calls markRepositoryRevoked / ReconcileDeps has no such dependency, and revoked is always 0', async () => {
    // A repo we hold active that GitHub no longer reports (the destructive direction spec.md
    // proposed) must be left untouched — OQ-5 (human-confirmed): additive-only for MVP.
    const deps = makeDeps({
      listOurRepos: vi.fn(async () => [
        { id: 'repo-uuid-other', externalId: '999-not-reported-by-github', revokedAt: null },
      ]),
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(async () => []),
        getInstallationRepo: vi.fn(),
      },
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result).toEqual({ installations: 1, registered: 0, enqueued: 0, revoked: 0, truncated: false });
    expect(deps.registerRepository).not.toHaveBeenCalled();
    expect('markRepositoryRevoked' in deps).toBe(false);
  });
});

describe('reconcileInstallationRepositories — truncation (informational only, no destructive action)', () => {
  it('marks truncated: true when an installation returns exactly MAX_RECONCILE_REPOS (25) repos', async () => {
    const fullList = Array.from({ length: 25 }, (_, i) =>
      makeInstalledRepo({ provider_repo_id: String(i), full_name: `acme/repo-${i}` }),
    );
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(async () => fullList),
        getInstallationRepo: vi.fn(),
      },
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result.truncated).toBe(true);
  });

  it('marks truncated: false at the cap minus one (24 repos)', async () => {
    const list = Array.from({ length: 24 }, (_, i) =>
      makeInstalledRepo({ provider_repo_id: String(i), full_name: `acme/repo-${i}` }),
    );
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(async () => list),
        getInstallationRepo: vi.fn(),
      },
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result.truncated).toBe(false);
  });

  it('passes MAX_RECONCILE_REPOS as the bound to listInstallationRepos', async () => {
    const deps = makeDeps();
    await reconcileInstallationRepositories(ctx(), deps);
    expect(deps.githubClient.listInstallationRepos).toHaveBeenCalledWith(555, 25);
  });
});

describe('reconcileInstallationRepositories — tenant isolation and failure semantics', () => {
  it('resolves org_id ONLY from ctx.orgId, scoping every read/write to it', async () => {
    const deps = makeDeps();
    await reconcileInstallationRepositories(ctx('org-resolved-42'), deps);
    expect(deps.resolveActiveInstallations).toHaveBeenCalledWith('org-resolved-42');
    expect(deps.listOurRepos).toHaveBeenCalledWith('org-resolved-42');
    expect(deps.withOrg).toHaveBeenCalledWith('org-resolved-42', expect.any(Function));
  });

  it('a listInstallationRepos failure for one installation fails the whole call, no partial write', async () => {
    const deps = makeDeps({
      resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }, { installationId: 777 }]),
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi
          .fn()
          .mockResolvedValueOnce([makeInstalledRepo()])
          .mockRejectedValueOnce(new Error('github down')),
        getInstallationRepo: vi.fn(),
      },
    });
    await expect(reconcileInstallationRepositories(ctx(), deps)).rejects.toThrow('github down');
    expect(deps.withOrg).not.toHaveBeenCalled();
    expect(deps.registerRepository).not.toHaveBeenCalled();
  });
});

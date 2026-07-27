// Fully DI-mocked unit tests for applyInstallationRepositoriesEvent — no Postgres, no
// network. resolveOrg/withOrg/githubClient/registerRepository/markRepositoryRevoked/
// enqueueInitialParse/kickInitialParseOutbox are all injected, mirroring the pattern in
// githubInstallationLifecycle.test.ts / githubWebhookService.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { RepoInitialParseEvent } from '@sayre/shared-types';
import type { MessageEnvelope } from '../queue/envelope';
import type { InstalledRepo } from '../github/appClient';
import {
  applyInstallationRepositoriesEvent,
  type InstallationRepositoriesDeps,
} from './githubInstallationRepositoriesService';

const SHA_A = 'a'.repeat(40);

function makeInstalledRepo(overrides: Partial<InstalledRepo> = {}): InstalledRepo {
  return {
    provider_repo_id: '111',
    full_name: 'acme/widgets',
    default_branch: 'main',
    default_branch_head_sha: SHA_A,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<InstallationRepositoriesDeps> = {}): InstallationRepositoriesDeps {
  return {
    resolveOrg: vi.fn(async () => ({ orgId: 'org-1', active: true })),
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    githubClient: {
      authorizeInstallation: vi.fn(),
      mintInstallationToken: vi.fn(),
      listInstallationRepos: vi.fn(),
      getInstallationRepo: vi.fn(async () => makeInstalledRepo()),
    },
    registerRepository: vi.fn(async () => ({ repoId: 'repo-uuid-1' })),
    markRepositoryRevoked: vi.fn(async () => true),
    enqueueInitialParse: vi.fn(async () => undefined),
    kickInitialParseOutbox: vi.fn(),
    ...overrides,
  } as InstallationRepositoriesDeps;
}

describe('applyInstallationRepositoriesEvent — added', () => {
  it('resolves HEAD, registers, and enqueues one envelope per added repo with a resolvable HEAD', async () => {
    const deps = makeDeps();
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
        removed: [],
      },
      deps,
    );
    expect(result).toEqual({ status: 'added', registered: 1, enqueued: 1 });
    expect(deps.githubClient.getInstallationRepo).toHaveBeenCalledWith(555, 'acme/widgets');
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
    expect(envelope.org_id).toBe('org-1');
    expect(envelope.type).toBe('repo.initial_parse');
    expect(envelope.source).toBe('github-app-install');
    expect(envelope.payload.reason).toBe('app_install');
    expect(envelope.payload.repo).toEqual({
      provider_repo_id: '111',
      full_name: 'acme/widgets',
      repo_id: 'repo-uuid-1',
    });
    expect(envelope.payload.ref).toBe('refs/heads/main');
    expect(envelope.payload.revision_sha).toBe(SHA_A);
  });

  it('registers multiple added repos and enqueues one job each', async () => {
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(),
        getInstallationRepo: vi.fn(async (_id: number, fullName: string) =>
          makeInstalledRepo({ provider_repo_id: fullName === 'acme/widgets' ? '111' : '222', full_name: fullName }),
        ),
      },
    });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [
          { providerRepoId: '111', fullName: 'acme/widgets' },
          { providerRepoId: '222', fullName: 'acme/gadgets' },
        ],
        removed: [],
      },
      deps,
    );
    expect(result).toEqual({ status: 'added', registered: 2, enqueued: 2 });
  });

  it('registers but does NOT enqueue when default_branch is null (empty repo)', async () => {
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(),
        getInstallationRepo: vi.fn(async () =>
          makeInstalledRepo({ default_branch: null, default_branch_head_sha: null }),
        ),
      },
    });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
        removed: [],
      },
      deps,
    );
    expect(result).toEqual({ status: 'added', registered: 1, enqueued: 0 });
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
    expect(deps.kickInitialParseOutbox).not.toHaveBeenCalled();
  });

  it('registers but does NOT enqueue when default_branch_head_sha is null (409 empty repo)', async () => {
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(),
        getInstallationRepo: vi.fn(async () =>
          makeInstalledRepo({ default_branch: 'main', default_branch_head_sha: null }),
        ),
      },
    });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
        removed: [],
      },
      deps,
    );
    expect(result).toEqual({ status: 'added', registered: 1, enqueued: 0 });
  });

  it('a 404 from getInstallationRepo (repo access already revoked) is skipped: no register, no enqueue', async () => {
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(),
        getInstallationRepo: vi.fn(async () => null),
      },
    });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [{ providerRepoId: '111', fullName: 'acme/gone' }],
        removed: [],
      },
      deps,
    );
    expect(result).toEqual({ status: 'added', registered: 0, enqueued: 0 });
    expect(deps.registerRepository).not.toHaveBeenCalled();
  });

  it('an unknown installation (resolveOrg returns null) is ignored, no writes, no network call', async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => null) });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 999,
        added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
        removed: [],
      },
      deps,
    );
    expect(result).toEqual({ status: 'ignored', reason: 'unknown_installation' });
    expect(deps.githubClient.getInstallationRepo).not.toHaveBeenCalled();
    expect(deps.registerRepository).not.toHaveBeenCalled();
  });

  it('an inactive (suspended/revoked) installation is ignored, no network call, no enqueue', async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => ({ orgId: 'org-1', active: false })) });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
        removed: [],
      },
      deps,
    );
    expect(result).toEqual({ status: 'ignored', reason: 'inactive_installation' });
    expect(deps.githubClient.getInstallationRepo).not.toHaveBeenCalled();
    expect(deps.registerRepository).not.toHaveBeenCalled();
  });

  it('a network failure resolving one repo rejects the whole call before any DB write (no partial commit)', async () => {
    const deps = makeDeps({
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(),
        getInstallationRepo: vi
          .fn()
          .mockResolvedValueOnce(makeInstalledRepo({ provider_repo_id: '111', full_name: 'acme/widgets' }))
          .mockRejectedValueOnce(new Error('network down')),
      },
    });
    await expect(
      applyInstallationRepositoriesEvent(
        {
          action: 'added',
          installationId: 555,
          added: [
            { providerRepoId: '111', fullName: 'acme/widgets' },
            { providerRepoId: '222', fullName: 'acme/gadgets' },
          ],
          removed: [],
        },
        deps,
      ),
    ).rejects.toThrow('network down');
    expect(deps.withOrg).not.toHaveBeenCalled();
    expect(deps.registerRepository).not.toHaveBeenCalled();
  });

  it('scopes the mutation via withOrg using the resolved org id (tenant isolation)', async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => ({ orgId: 'org-resolved-42', active: true })) });
    await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
        removed: [],
      },
      deps,
    );
    expect(deps.withOrg).toHaveBeenCalledWith('org-resolved-42', expect.any(Function));
  });
});

describe('applyInstallationRepositoriesEvent — removed', () => {
  it('revokes each removed repo and returns the revoked count', async () => {
    const deps = makeDeps();
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'removed',
        installationId: 555,
        added: [],
        removed: [
          { providerRepoId: '111', fullName: 'acme/widgets' },
          { providerRepoId: '222', fullName: 'acme/gadgets' },
        ],
      },
      deps,
    );
    expect(result).toEqual({ status: 'removed', revoked: 2 });
    expect(deps.markRepositoryRevoked).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-1',
      providerRepoId: '111',
    });
    expect(deps.markRepositoryRevoked).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-1',
      providerRepoId: '222',
    });
    expect(deps.githubClient.getInstallationRepo).not.toHaveBeenCalled();
  });

  it('runs regardless of installation active/inactive state (revoke is safe/idempotent)', async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => ({ orgId: 'org-1', active: false })) });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'removed',
        installationId: 555,
        added: [],
        removed: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      },
      deps,
    );
    expect(result).toEqual({ status: 'removed', revoked: 1 });
  });

  it('a redelivered removed event for an already-revoked repo is a true no-op at the data level (COALESCE never advances revoked_at, but the writer still reports a row match)', async () => {
    // markRepositoryRevoked's WHERE clause matches on (org_id, provider='github', external_id)
    // only — it has no `revoked_at IS NULL` guard — so it returns true on every redelivery where
    // the row exists, whether or not that row was already revoked. The actual idempotency
    // guarantee is that revoked_at itself never advances past its first-set value (COALESCE on
    // the value, not on the row-matched count); see githubAppInstallWrites.ts.
    const deps = makeDeps({ markRepositoryRevoked: vi.fn(async () => true) });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'removed',
        installationId: 555,
        added: [],
        removed: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      },
      deps,
    );
    expect(result).toEqual({ status: 'removed', revoked: 1 });
  });

  it('an unknown installation is ignored, no revoke attempted', async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => null) });
    const result = await applyInstallationRepositoriesEvent(
      {
        action: 'removed',
        installationId: 999,
        added: [],
        removed: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      },
      deps,
    );
    expect(result).toEqual({ status: 'ignored', reason: 'unknown_installation' });
    expect(deps.markRepositoryRevoked).not.toHaveBeenCalled();
  });

  it('never calls kickInitialParseOutbox on the removed path', async () => {
    const deps = makeDeps();
    await applyInstallationRepositoriesEvent(
      {
        action: 'removed',
        installationId: 555,
        added: [],
        removed: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      },
      deps,
    );
    expect(deps.kickInitialParseOutbox).not.toHaveBeenCalled();
  });
});

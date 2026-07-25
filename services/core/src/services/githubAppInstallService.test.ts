// Fully DI-mocked unit tests for startGithubAppInstall / handleGithubAppCallback
// — no real GitHub API, no Postgres, no SQS. Mirrors the DI-mock pattern in
// githubWebhookService.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import {
  GithubAppAuthorizationError,
  type GithubAppClient,
  type InstalledRepo,
} from '../github/appClient';
import { InstallStateError } from '../github/installState';
import {
  GithubApiError,
  GithubInstallationAuthorizationError,
  InstallationOrgConflictError,
  InstallCallbackBadRequestError,
  handleGithubAppCallback,
  startGithubAppInstall,
  type CallbackInput,
  type InstallCallbackDeps,
} from './githubAppInstallService';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

beforeEach(() => {
  setConfigOverrideForTests('GITHUB_WEB_BASE_URL', 'https://github.test');
  setConfigOverrideForTests('GITHUB_APP_SLUG', 'sayre-app');
  setConfigOverrideForTests('GITHUB_POST_INSTALL_REDIRECT_URL', '/settings/integrations');
});

afterEach(() => {
  resetConfigForTests();
});

describe('startGithubAppInstall', () => {
  it('redirects to GITHUB_WEB_BASE_URL/apps/<slug>/installations/new?state=<signed>', async () => {
    const signState = vi.fn(async (orgId: string) => `signed-state-for-${orgId}`);
    const result = await startGithubAppInstall({ orgId: 'org-42' }, { signState });
    expect(result.redirectTo).toBe(
      'https://github.test/apps/sayre-app/installations/new?state=signed-state-for-org-42',
    );
    expect(signState).toHaveBeenCalledWith('org-42');
  });

  it('URL-encodes the state token', async () => {
    const signState = vi.fn(async () => 'a.b+c/d=');
    const result = await startGithubAppInstall({ orgId: 'org-42' }, { signState });
    expect(result.redirectTo).toContain(encodeURIComponent('a.b+c/d='));
  });
});

function makeRepo(overrides: Partial<InstalledRepo> = {}): InstalledRepo {
  return {
    provider_repo_id: '1',
    full_name: 'acme/widgets',
    default_branch: 'main',
    default_branch_head_sha: SHA_A,
    ...overrides,
  };
}

function makeGithubClient(overrides: Partial<GithubAppClient> = {}): GithubAppClient {
  return {
    authorizeInstallation: vi.fn(async () => ({
      account_login: 'acme',
      account_type: 'Organization' as const,
    })),
    mintInstallationToken: vi.fn(async () => 'ghs_fake'),
    listInstallationRepos: vi.fn(async () => [makeRepo()]),
    ...overrides,
  };
}

function authorizedCallback(overrides: CallbackInput = {}): CallbackInput {
  return {
    state: 'x',
    installationId: '555',
    code: 'one-time-oauth-code',
    ...overrides,
  };
}

interface Deps extends InstallCallbackDeps {
  verifyState: ReturnType<typeof vi.fn>;
  resolveExistingInstallationOrg: ReturnType<typeof vi.fn>;
  withOrg: ReturnType<typeof vi.fn>;
  getDb: ReturnType<typeof vi.fn>;
  enqueueInitialParse: ReturnType<typeof vi.fn>;
  kickInitialParseOutbox: ReturnType<typeof vi.fn>;
  upsertInstallation: ReturnType<typeof vi.fn>;
  registerRepository: ReturnType<typeof vi.fn>;
}

function makeCallbackDeps(overrides: Partial<Deps> = {}): Deps {
  let repoCounter = 0;
  return {
    verifyState: vi.fn(async () => ({ org_id: 'org-resolved-1', nonce: 'n', purpose: 'github_app_install' as const })),
    resolveExistingInstallationOrg: vi.fn(async () => null),
    githubClient: makeGithubClient(),
    withOrg: vi.fn(async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    getDb: vi.fn(async () => ({}) as never),
    enqueueInitialParse: vi.fn(async () => undefined),
    kickInitialParseOutbox: vi.fn(),
    upsertInstallation: vi.fn(async () => undefined),
    registerRepository: vi.fn(async () => ({ repoId: `repo-${(repoCounter += 1)}` })),
    ...overrides,
  } as Deps;
}

describe('handleGithubAppCallback — state validation (400s)', () => {
  it('throws InstallCallbackBadRequestError when state is missing', async () => {
    const deps = makeCallbackDeps();
    await expect(
      handleGithubAppCallback({ installationId: '555' }, deps),
    ).rejects.toBeInstanceOf(InstallCallbackBadRequestError);
    expect(deps.resolveExistingInstallationOrg).not.toHaveBeenCalled();
  });

  it('throws InstallCallbackBadRequestError when verifyState rejects with InstallStateError', async () => {
    const deps = makeCallbackDeps({
      verifyState: vi.fn(async () => {
        throw new InstallStateError();
      }),
    });
    await expect(
      handleGithubAppCallback({ installationId: '555', state: 'bad' }, deps),
    ).rejects.toBeInstanceOf(InstallCallbackBadRequestError);
  });

  it('rethrows a non-InstallStateError failure from verifyState uncaught (infra failure -> 500)', async () => {
    const deps = makeCallbackDeps({
      verifyState: vi.fn(async () => {
        throw new Error('secret loader down');
      }),
    });
    await expect(
      handleGithubAppCallback({ installationId: '555', state: 'x' }, deps),
    ).rejects.toThrow('secret loader down');
  });

  it('throws InstallCallbackBadRequestError when installation_id is missing', async () => {
    const deps = makeCallbackDeps();
    await expect(
      handleGithubAppCallback({ state: 'x' }, deps),
    ).rejects.toBeInstanceOf(InstallCallbackBadRequestError);
    expect(deps.githubClient.listInstallationRepos).not.toHaveBeenCalled();
  });

  it('throws InstallCallbackBadRequestError when installation_id is non-numeric', async () => {
    const deps = makeCallbackDeps();
    await expect(
      handleGithubAppCallback({ state: 'x', installationId: 'not-a-number' }, deps),
    ).rejects.toBeInstanceOf(InstallCallbackBadRequestError);
  });

  it('throws InstallCallbackBadRequestError when the one-time OAuth code is missing', async () => {
    const deps = makeCallbackDeps();
    await expect(
      handleGithubAppCallback({ state: 'x', installationId: '555' }, deps),
    ).rejects.toBeInstanceOf(InstallCallbackBadRequestError);
    expect(deps.githubClient.authorizeInstallation).not.toHaveBeenCalled();
    expect(deps.resolveExistingInstallationOrg).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — setup_action=request (pending approval)', () => {
  it('redirects without minting a token, writing rows, or enqueuing anything', async () => {
    const deps = makeCallbackDeps();
    const result = await handleGithubAppCallback(
      { state: 'x', setupAction: 'request' },
      deps,
    );
    expect(result).toEqual({ redirectTo: '/settings/integrations', enqueuedRepos: 0 });
    expect(deps.githubClient.listInstallationRepos).not.toHaveBeenCalled();
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — GitHub identity authorization', () => {
  it('rejects an arbitrary installation id before tenant lookup, repo listing, or writes', async () => {
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        authorizeInstallation: vi.fn(async () => {
          throw new GithubAppAuthorizationError();
        }),
      }),
    });

    await expect(
      handleGithubAppCallback(authorizedCallback(), deps),
    ).rejects.toBeInstanceOf(GithubInstallationAuthorizationError);
    expect(deps.resolveExistingInstallationOrg).not.toHaveBeenCalled();
    expect(deps.githubClient.listInstallationRepos).not.toHaveBeenCalled();
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — happy path', () => {
  it('AC3: writes one installation row, registers each repo, and enqueues one repo.initial_parse per repo', async () => {
    const repos = [
      makeRepo({
        provider_repo_id: '1',
        full_name: 'acme/widgets',
        default_branch: 'main',
        default_branch_head_sha: SHA_A,
      }),
      makeRepo({
        provider_repo_id: '2',
        full_name: 'acme/gadgets',
        default_branch: 'trunk',
        default_branch_head_sha: SHA_B,
      }),
    ];
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        listInstallationRepos: vi.fn(async () => repos),
      }),
    });

    const result = await handleGithubAppCallback(authorizedCallback(), deps);

    expect(result).toEqual({ redirectTo: '/settings/integrations', enqueuedRepos: 2 });
    expect(deps.githubClient.authorizeInstallation).toHaveBeenCalledWith(
      'one-time-oauth-code',
      555,
    );
    expect(deps.upsertInstallation).toHaveBeenCalledTimes(1);
    expect(deps.upsertInstallation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        orgId: 'org-resolved-1',
        installationId: 555,
        accountLogin: 'acme',
        accountType: 'Organization',
      }),
    );
    expect(deps.registerRepository).toHaveBeenCalledTimes(2);
    expect(deps.enqueueInitialParse).toHaveBeenCalledTimes(2);
    expect(deps.kickInitialParseOutbox).toHaveBeenCalledOnce();

    const [, envelope1] = deps.enqueueInitialParse.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(envelope1.type).toBe('repo.initial_parse');
    expect(envelope1.source).toBe('github-app-install');
    expect(envelope1.org_id).toBe('org-resolved-1');
    expect(envelope1.idempotency_key).toBe(
      `github:initial_parse:555:1:refs/heads/main:${SHA_A}`,
    );
    expect(envelope1.payload).toMatchObject({
      provider: 'github',
      type: 'initial_parse',
      repo: { provider_repo_id: '1', full_name: 'acme/widgets', repo_id: 'repo-1' },
      ref: 'refs/heads/main',
      revision_sha: SHA_A,
      installation_id: '555',
      reason: 'app_install',
    });
  });

  it('zero repos: installation row written, zero enqueues, no error', async () => {
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        listInstallationRepos: vi.fn(async () => []),
      }),
    });
    const result = await handleGithubAppCallback(authorizedCallback(), deps);
    expect(result.enqueuedRepos).toBe(0);
    expect(deps.upsertInstallation).toHaveBeenCalledTimes(1);
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
    expect(deps.kickInitialParseOutbox).not.toHaveBeenCalled();
  });

  it('a repo with default_branch=null is registered but excluded from enqueuedRepos', async () => {
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        listInstallationRepos: vi.fn(async () => [
          makeRepo({
            provider_repo_id: '1',
            default_branch: null,
            default_branch_head_sha: null,
          }),
          makeRepo({ provider_repo_id: '2', default_branch: 'main' }),
        ]),
      }),
    });
    const result = await handleGithubAppCallback(authorizedCallback(), deps);
    expect(result.enqueuedRepos).toBe(1);
    expect(deps.registerRepository).toHaveBeenCalledTimes(2);
    expect(deps.enqueueInitialParse).toHaveBeenCalledTimes(1);
  });

  it('a repo whose default branch has no HEAD is registered but not enqueued', async () => {
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        listInstallationRepos: vi.fn(async () => [
          makeRepo({ default_branch: 'main', default_branch_head_sha: null }),
        ]),
      }),
    });

    const result = await handleGithubAppCallback(authorizedCallback(), deps);

    expect(result.enqueuedRepos).toBe(0);
    expect(deps.registerRepository).toHaveBeenCalledTimes(1);
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
  });

  it('O-5 deviation: caps processing at the first 25 repos, silently excluding the rest', async () => {
    const repos = Array.from({ length: 30 }, (_, i) =>
      makeRepo({ provider_repo_id: String(i), full_name: `acme/repo-${i}`, default_branch: 'main' }),
    );
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        listInstallationRepos: vi.fn(async () => repos),
      }),
    });
    const result = await handleGithubAppCallback(authorizedCallback(), deps);
    expect(result.enqueuedRepos).toBe(25);
    expect(deps.registerRepository).toHaveBeenCalledTimes(25);
    expect(deps.enqueueInitialParse).toHaveBeenCalledTimes(25);
    expect(deps.githubClient.listInstallationRepos).toHaveBeenCalledWith(555, 25);
  });

  it('persists the outbox row inside the tenant transaction, then wakes delivery after commit', async () => {
    const order: string[] = [];
    const deps = makeCallbackDeps({
      withOrg: vi.fn(async (_db, _orgId, fn) => {
        order.push('transaction-started');
        const result = await fn({});
        order.push('transaction-committed');
        return result;
      }),
      enqueueInitialParse: vi.fn(async () => {
        order.push('outbox-persisted');
      }),
      kickInitialParseOutbox: vi.fn(() => {
        order.push('dispatcher-woken');
      }),
    });

    await handleGithubAppCallback(authorizedCallback(), deps);

    expect(order).toEqual([
      'transaction-started',
      'outbox-persisted',
      'transaction-committed',
      'dispatcher-woken',
    ]);
  });

  it('does not wake delivery when the tenant transaction rolls back', async () => {
    const deps = makeCallbackDeps({
      registerRepository: vi.fn(async () => {
        throw new Error('transaction failed');
      }),
    });

    await expect(handleGithubAppCallback(authorizedCallback(), deps)).rejects.toThrow(
      'transaction failed',
    );
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
    expect(deps.kickInitialParseOutbox).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — tenant isolation / conflict (409)', () => {
  it('AC9: an installation already bound to a different org is rejected, no DB write, no enqueue', async () => {
    const deps = makeCallbackDeps({
      resolveExistingInstallationOrg: vi.fn(async () => ({ orgId: 'org-OTHER', active: true })),
    });
    await expect(
      handleGithubAppCallback(authorizedCallback(), deps),
    ).rejects.toBeInstanceOf(InstallationOrgConflictError);
    expect(deps.githubClient.listInstallationRepos).not.toHaveBeenCalled();
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
  });

  it('an installation already bound to the SAME org (setup_action=update) proceeds without conflict', async () => {
    const deps = makeCallbackDeps({
      resolveExistingInstallationOrg: vi.fn(async () => ({ orgId: 'org-resolved-1', active: true })),
    });
    const result = await handleGithubAppCallback(
      authorizedCallback({ setupAction: 'update' }),
      deps,
    );
    expect(result.enqueuedRepos).toBe(1);
  });

  it('a forged org_id-shaped field in the callback input is never read — org comes only from verified state', async () => {
    const deps = makeCallbackDeps();
    const forgedInput = {
      state: 'x',
      installationId: '555',
      code: 'one-time-oauth-code',
      org_id: 'attacker-org',
    } as unknown as CallbackInput;
    await handleGithubAppCallback(forgedInput, deps);
    expect(deps.upsertInstallation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: 'org-resolved-1' }),
    );
  });
});

describe('handleGithubAppCallback — GitHub API failures (502)', () => {
  it('token mint / repo-list failure -> GithubApiError, no rows written, no enqueue', async () => {
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        listInstallationRepos: vi.fn(async () => {
          throw new Error('GitHub API request to /app/installations/555/access_tokens returned 401.');
        }),
      }),
    });
    await expect(
      handleGithubAppCallback(authorizedCallback(), deps),
    ).rejects.toBeInstanceOf(GithubApiError);
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — idempotency', () => {
  it('replaying the identical callback produces the same idempotency_key both times', async () => {
    const deps = makeCallbackDeps();
    await handleGithubAppCallback(authorizedCallback(), deps);
    await handleGithubAppCallback(authorizedCallback(), deps);
    const [, first] = deps.enqueueInitialParse.mock.calls[0] as [
      unknown,
      { idempotency_key: string },
    ];
    const [, second] = deps.enqueueInitialParse.mock.calls[1] as [
      unknown,
      { idempotency_key: string },
    ];
    expect(first.idempotency_key).toBe(second.idempotency_key);
  });

  it('uses the immutable revision SHA in the idempotency key', async () => {
    const listInstallationRepos = vi
      .fn()
      .mockResolvedValueOnce([makeRepo({ default_branch_head_sha: SHA_A })])
      .mockResolvedValueOnce([makeRepo({ default_branch_head_sha: SHA_B })]);
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        listInstallationRepos,
      }),
    });

    await handleGithubAppCallback(authorizedCallback(), deps);
    await handleGithubAppCallback(authorizedCallback(), deps);

    const [, first] = deps.enqueueInitialParse.mock.calls[0] as [
      unknown,
      { idempotency_key: string },
    ];
    const [, second] = deps.enqueueInitialParse.mock.calls[1] as [
      unknown,
      { idempotency_key: string },
    ];
    expect(first.idempotency_key).toContain(SHA_A);
    expect(second.idempotency_key).toContain(SHA_B);
    expect(first.idempotency_key).not.toBe(second.idempotency_key);
  });
});

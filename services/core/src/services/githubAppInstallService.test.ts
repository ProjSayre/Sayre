// Fully DI-mocked unit tests for startGithubAppInstall / handleGithubAppCallback
// — no real GitHub API, no Postgres, no SQS. Mirrors the DI-mock pattern in
// githubWebhookService.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import type { InstalledRepo } from '../github/appClient';
import { InstallStateError } from '../github/installState';
import {
  GithubApiError,
  InstallationOrgConflictError,
  InstallCallbackBadRequestError,
  handleGithubAppCallback,
  startGithubAppInstall,
  type CallbackInput,
  type InstallCallbackDeps,
} from './githubAppInstallService';

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
    ...overrides,
  };
}

interface Deps extends InstallCallbackDeps {
  verifyState: ReturnType<typeof vi.fn>;
  resolveExistingInstallationOrg: ReturnType<typeof vi.fn>;
  withOrg: ReturnType<typeof vi.fn>;
  getDb: ReturnType<typeof vi.fn>;
  publishInitialParse: ReturnType<typeof vi.fn>;
  upsertInstallation: ReturnType<typeof vi.fn>;
  registerRepository: ReturnType<typeof vi.fn>;
}

function makeCallbackDeps(overrides: Partial<Deps> = {}): Deps {
  let repoCounter = 0;
  return {
    verifyState: vi.fn(async () => ({ org_id: 'org-resolved-1', nonce: 'n', purpose: 'github_app_install' as const })),
    resolveExistingInstallationOrg: vi.fn(async () => null),
    githubClient: {
      mintInstallationToken: vi.fn(async () => 'ghs_fake'),
      listInstallationRepos: vi.fn(async () => [makeRepo()]),
    },
    withOrg: vi.fn(async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    getDb: vi.fn(async () => ({}) as never),
    publishInitialParse: vi.fn(async () => undefined),
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
    expect(deps.publishInitialParse).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — happy path', () => {
  it('AC3: writes one installation row, registers each repo, and enqueues one repo.initial_parse per repo', async () => {
    const repos = [
      makeRepo({ provider_repo_id: '1', full_name: 'acme/widgets', default_branch: 'main' }),
      makeRepo({ provider_repo_id: '2', full_name: 'acme/gadgets', default_branch: 'trunk' }),
    ];
    const deps = makeCallbackDeps({
      githubClient: {
        mintInstallationToken: vi.fn(async () => 'ghs_fake'),
        listInstallationRepos: vi.fn(async () => repos),
      },
    });

    const result = await handleGithubAppCallback({ state: 'x', installationId: '555' }, deps);

    expect(result).toEqual({ redirectTo: '/settings/integrations', enqueuedRepos: 2 });
    expect(deps.upsertInstallation).toHaveBeenCalledTimes(1);
    expect(deps.upsertInstallation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: 'org-resolved-1', installationId: 555 }),
    );
    expect(deps.registerRepository).toHaveBeenCalledTimes(2);
    expect(deps.publishInitialParse).toHaveBeenCalledTimes(2);

    const [envelope1] = deps.publishInitialParse.mock.calls[0] as [Record<string, unknown>];
    expect(envelope1.type).toBe('repo.initial_parse');
    expect(envelope1.source).toBe('github-app-install');
    expect(envelope1.org_id).toBe('org-resolved-1');
    expect(envelope1.idempotency_key).toBe('github:initial_parse:555:1:main');
    expect(envelope1.payload).toMatchObject({
      provider: 'github',
      type: 'initial_parse',
      repo: { provider_repo_id: '1', full_name: 'acme/widgets', repo_id: 'repo-1' },
      ref: 'main',
      installation_id: '555',
      reason: 'app_install',
    });
  });

  it('zero repos: installation row written, zero enqueues, no error', async () => {
    const deps = makeCallbackDeps({
      githubClient: {
        mintInstallationToken: vi.fn(async () => 'ghs_fake'),
        listInstallationRepos: vi.fn(async () => []),
      },
    });
    const result = await handleGithubAppCallback({ state: 'x', installationId: '555' }, deps);
    expect(result.enqueuedRepos).toBe(0);
    expect(deps.upsertInstallation).toHaveBeenCalledTimes(1);
    expect(deps.publishInitialParse).not.toHaveBeenCalled();
  });

  it('a repo with default_branch=null is registered but excluded from enqueuedRepos', async () => {
    const deps = makeCallbackDeps({
      githubClient: {
        mintInstallationToken: vi.fn(async () => 'ghs_fake'),
        listInstallationRepos: vi.fn(async () => [
          makeRepo({ provider_repo_id: '1', default_branch: null }),
          makeRepo({ provider_repo_id: '2', default_branch: 'main' }),
        ]),
      },
    });
    const result = await handleGithubAppCallback({ state: 'x', installationId: '555' }, deps);
    expect(result.enqueuedRepos).toBe(1);
    expect(deps.registerRepository).toHaveBeenCalledTimes(2);
    expect(deps.publishInitialParse).toHaveBeenCalledTimes(1);
  });

  it('O-5 deviation: caps processing at the first 25 repos, silently excluding the rest', async () => {
    const repos = Array.from({ length: 30 }, (_, i) =>
      makeRepo({ provider_repo_id: String(i), full_name: `acme/repo-${i}`, default_branch: 'main' }),
    );
    const deps = makeCallbackDeps({
      githubClient: {
        mintInstallationToken: vi.fn(async () => 'ghs_fake'),
        listInstallationRepos: vi.fn(async () => repos),
      },
    });
    const result = await handleGithubAppCallback({ state: 'x', installationId: '555' }, deps);
    expect(result.enqueuedRepos).toBe(25);
    expect(deps.registerRepository).toHaveBeenCalledTimes(25);
    expect(deps.publishInitialParse).toHaveBeenCalledTimes(25);
  });
});

describe('handleGithubAppCallback — tenant isolation / conflict (409)', () => {
  it('AC9: an installation already bound to a different org is rejected, no DB write, no enqueue', async () => {
    const deps = makeCallbackDeps({
      resolveExistingInstallationOrg: vi.fn(async () => ({ orgId: 'org-OTHER', active: true })),
    });
    await expect(
      handleGithubAppCallback({ state: 'x', installationId: '555' }, deps),
    ).rejects.toBeInstanceOf(InstallationOrgConflictError);
    expect(deps.githubClient.listInstallationRepos).not.toHaveBeenCalled();
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
  });

  it('an installation already bound to the SAME org (setup_action=update) proceeds without conflict', async () => {
    const deps = makeCallbackDeps({
      resolveExistingInstallationOrg: vi.fn(async () => ({ orgId: 'org-resolved-1', active: true })),
    });
    const result = await handleGithubAppCallback(
      { state: 'x', installationId: '555', setupAction: 'update' },
      deps,
    );
    expect(result.enqueuedRepos).toBe(1);
  });

  it('a forged org_id-shaped field in the callback input is never read — org comes only from verified state', async () => {
    const deps = makeCallbackDeps();
    const forgedInput = {
      state: 'x',
      installationId: '555',
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
      githubClient: {
        mintInstallationToken: vi.fn(async () => 'ghs_fake'),
        listInstallationRepos: vi.fn(async () => {
          throw new Error('GitHub API request to /app/installations/555/access_tokens returned 401.');
        }),
      },
    });
    await expect(
      handleGithubAppCallback({ state: 'x', installationId: '555' }, deps),
    ).rejects.toBeInstanceOf(GithubApiError);
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.publishInitialParse).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — idempotency', () => {
  it('replaying the identical callback produces the same idempotency_key both times', async () => {
    const deps = makeCallbackDeps();
    await handleGithubAppCallback({ state: 'x', installationId: '555' }, deps);
    await handleGithubAppCallback({ state: 'x', installationId: '555' }, deps);
    const [first] = deps.publishInitialParse.mock.calls[0] as [{ idempotency_key: string }];
    const [second] = deps.publishInitialParse.mock.calls[1] as [{ idempotency_key: string }];
    expect(first.idempotency_key).toBe(second.idempotency_key);
  });
});

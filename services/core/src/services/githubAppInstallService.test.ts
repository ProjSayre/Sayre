// Fully DI-mocked unit tests for startGithubAppInstall / handleGithubAppCallback
// — no real GitHub API, no Postgres, no BullMQ. Mirrors the DI-mock pattern in
// githubWebhookService.test.ts.
//
// W7-01: the callback is now row-write-only (no repo listing/registration/enqueue on the
// request path — see githubAppInstallService.discoveryCallback.test.ts for the AC-1/EC-7/EC-8
// behavioral coverage that replaced this file's old "happy path" repo-registration assertions).
// What stays here is what's still true post-W7-01: state validation, GitHub identity
// authorization failures, and the org-conflict guard, all against the new CallbackResult shape
// and InstallCallbackDeps (startInstallationSync/kickDiscoveryDispatcher, not
// registerRepository/enqueueInitialParse/kickInitialParseOutbox).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { GithubAppAuthorizationError, type GithubAppClient } from '../github/appClient';
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

function makeGithubClient(overrides: Partial<GithubAppClient> = {}): GithubAppClient {
  return {
    authorizeInstallation: vi.fn(async () => ({
      account_login: 'acme',
      account_type: 'Organization' as const,
    })),
    mintInstallationToken: vi.fn(async () => 'ghs_fake'),
    getInstallationRepo: vi.fn(),
    // W7-01 (AC-1): the callback must never call this — a fake that throws if reached
    // correctly documents/enforces "the callback performs no repository listing".
    listInstallationReposPage: vi.fn(async () => {
      throw new Error('listInstallationReposPage must not be called by the install callback.');
    }),
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
  upsertInstallation: ReturnType<typeof vi.fn>;
  startInstallationSync: ReturnType<typeof vi.fn>;
  kickDiscoveryDispatcher: ReturnType<typeof vi.fn>;
}

function makeCallbackDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    verifyState: vi.fn(async () => ({ org_id: 'org-resolved-1', nonce: 'n', purpose: 'github_app_install' as const })),
    resolveExistingInstallationOrg: vi.fn(async () => null),
    githubClient: makeGithubClient(),
    withOrg: vi.fn(async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    getDb: vi.fn(async () => ({}) as never),
    upsertInstallation: vi.fn(async () => undefined),
    startInstallationSync: vi.fn(async () => ({ reset: true, runId: 'run-uuid-1' })),
    kickDiscoveryDispatcher: vi.fn(),
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
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
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
  it('redirects without minting a token, writing rows, or dispatching anything', async () => {
    const deps = makeCallbackDeps();
    const result = await handleGithubAppCallback(
      { state: 'x', setupAction: 'request' },
      deps,
    );
    expect(result).toEqual({ redirectTo: '/settings/integrations', discovery: 'skipped' });
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — GitHub identity authorization', () => {
  it('rejects an arbitrary installation id before tenant lookup or any write', async () => {
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
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — happy path (row-write-only, W7-01)', () => {
  it('writes one installation row and one pending sync row, kicks the dispatcher, returns { discovery: "queued" }', async () => {
    const deps = makeCallbackDeps();

    const result = await handleGithubAppCallback(authorizedCallback(), deps);

    expect(result).toEqual({ redirectTo: '/settings/integrations', discovery: 'queued' });
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
    expect(deps.startInstallationSync).toHaveBeenCalledTimes(1);
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        orgId: 'org-resolved-1',
        installationId: 555,
        reason: 'app_install',
        requestedBy: null,
      }),
    );
    expect(deps.kickDiscoveryDispatcher).toHaveBeenCalledOnce();
  });

  it('persists the sync row inside the tenant transaction, then wakes the dispatcher after commit', async () => {
    const order: string[] = [];
    const deps = makeCallbackDeps({
      withOrg: vi.fn(async (_db, _orgId, fn) => {
        order.push('transaction-started');
        const result = await fn({});
        order.push('transaction-committed');
        return result;
      }),
      startInstallationSync: vi.fn(async () => {
        order.push('sync-row-written');
        return { reset: true, runId: 'run-uuid-1' };
      }),
      kickDiscoveryDispatcher: vi.fn(() => {
        order.push('dispatcher-woken');
      }),
    });

    await handleGithubAppCallback(authorizedCallback(), deps);

    expect(order).toEqual([
      'transaction-started',
      'sync-row-written',
      'transaction-committed',
      'dispatcher-woken',
    ]);
  });

  it('does not wake the dispatcher when the tenant transaction rolls back', async () => {
    const deps = makeCallbackDeps({
      upsertInstallation: vi.fn(async () => {
        throw new Error('transaction failed');
      }),
    });

    await expect(handleGithubAppCallback(authorizedCallback(), deps)).rejects.toThrow(
      'transaction failed',
    );
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — tenant isolation / conflict (409)', () => {
  it('AC9: an installation already bound to a different org is rejected, no DB write, no dispatch', async () => {
    const deps = makeCallbackDeps({
      resolveExistingInstallationOrg: vi.fn(async () => ({ orgId: 'org-OTHER', active: true })),
    });
    await expect(
      handleGithubAppCallback(authorizedCallback(), deps),
    ).rejects.toBeInstanceOf(InstallationOrgConflictError);
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
  });

  it('an installation already bound to the SAME org (setup_action=update) proceeds without conflict', async () => {
    const deps = makeCallbackDeps({
      resolveExistingInstallationOrg: vi.fn(async () => ({ orgId: 'org-resolved-1', active: true })),
    });
    const result = await handleGithubAppCallback(
      authorizedCallback({ setupAction: 'update' }),
      deps,
    );
    expect(result.discovery).toBe('queued');
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
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ orgId: 'org-resolved-1' }),
    );
  });
});

describe('handleGithubAppCallback — GitHub API failures (502)', () => {
  it('authorization failure -> GithubApiError, no rows written, no dispatch', async () => {
    const deps = makeCallbackDeps({
      githubClient: makeGithubClient({
        authorizeInstallation: vi.fn(async () => {
          throw new Error('GitHub API request to /app/installations/555 returned 500.');
        }),
      }),
    });
    await expect(
      handleGithubAppCallback(authorizedCallback(), deps),
    ).rejects.toBeInstanceOf(GithubApiError);
    expect(deps.upsertInstallation).not.toHaveBeenCalled();
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
  });
});

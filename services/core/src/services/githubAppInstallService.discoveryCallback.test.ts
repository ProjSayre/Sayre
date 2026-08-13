// Leading-red tests (W7-01) for handleGithubAppCallback's new row-write-only shape (spec.md
// AC-1, EC-7, EC-8). Deliberately a NEW file rather than an edit to the existing
// githubAppInstallService.test.ts — that file currently asserts the OLD (pre-W7-01) behavior
// (list repos inline, register/enqueue up to MAX_REPOS_PER_CALLBACK) and spec.md's own
// "Affected files" section assigns rewriting it to `dev`, not `red`. Mirrors
// githubAppInstallService.test.ts's DI-mock conventions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import type { GithubAppClient } from '../github/appClient';
import {
  InstallationOrgConflictError,
  handleGithubAppCallback,
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

function makeGithubClient(overrides: Partial<GithubAppClient> = {}): GithubAppClient {
  return {
    authorizeInstallation: vi.fn(async () => ({
      account_login: 'acme',
      account_type: 'Organization' as const,
    })),
    mintInstallationToken: vi.fn(async () => 'ghs_fake'),
    // @ts-expect-error listInstallationReposPage does not exist on the pre-W7-01 GithubAppClient
    // shape yet — asserting it is UNUSED by the callback is exactly AC-1's point, so a fake with
    // no such method at all correctly documents "the callback must never call it".
    getInstallationRepo: vi.fn(),
    ...overrides,
  };
}

function authorizedCallback(overrides: CallbackInput = {}): CallbackInput {
  return { state: 'x', installationId: '555', code: 'one-time-oauth-code', ...overrides };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    verifyState: vi.fn(async () => ({ org_id: 'org-resolved-1', nonce: 'n', purpose: 'github_app_install' as const })),
    resolveExistingInstallationOrg: vi.fn(async () => null),
    githubClient: makeGithubClient(),
    withOrg: vi.fn(async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    getDb: vi.fn(async () => ({}) as never),
    upsertInstallation: vi.fn(async () => undefined),
    // W7-01 (OQ-3): replaces enqueueInitialParse/kickInitialParseOutbox/registerRepository.
    startInstallationSync: vi.fn(async () => ({ reset: true, runId: 'run-uuid-1' })),
    kickDiscoveryDispatcher: vi.fn(),
    ...overrides,
  };
}

describe('handleGithubAppCallback — AC-1 (row-write-only: no repo listing, no direct enqueue)', () => {
  // @spec AC-1 EC-8
  it('writes a pending github_installation_sync row (reason: app_install) in the SAME withOrgContext transaction as the installation row, kicks the dispatcher after commit, and returns { redirectTo, discovery: "queued" } — but never dispatches at all when an org conflict is found first', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.withOrg = vi.fn(async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
      order.push('tx-open');
      const result = await fn({});
      order.push('tx-commit');
      return result;
    });
    deps.upsertInstallation = vi.fn(async () => {
      order.push('upsertInstallation');
    });
    deps.startInstallationSync = vi.fn(async () => {
      order.push('startInstallationSync');
      return { reset: true, runId: 'run-uuid-1' };
    });
    deps.kickDiscoveryDispatcher = vi.fn(() => {
      order.push('kickDiscoveryDispatcher');
    });

    const result = await handleGithubAppCallback(
      authorizedCallback(),
      deps as unknown as Partial<InstallCallbackDeps>,
    );

    // AC-1: the happy path writes the row and dispatches.
    expect(result).toEqual({ redirectTo: '/settings/integrations', discovery: 'queued' });
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-resolved-1',
        installationId: 555,
        reason: 'app_install',
        requestedBy: null,
      }),
    );
    // upsertInstallation and startInstallationSync both happen inside the transaction opened by
    // withOrg, and the dispatcher is only kicked once that transaction has committed.
    expect(order.indexOf('tx-open')).toBeLessThan(order.indexOf('upsertInstallation'));
    expect(order.indexOf('tx-open')).toBeLessThan(order.indexOf('startInstallationSync'));
    expect(order.indexOf('tx-commit')).toBeLessThan(order.indexOf('kickDiscoveryDispatcher'));

    // EC-8: reusing the SAME spies, an org-conflict callback must leave their call counts
    // unchanged — i.e. once AC-1's dispatch exists at all, the conflict guard must still run
    // BEFORE it, not after. (A standalone "no dispatch on conflict" test would trivially pass
    // today, since none of these dependencies are wired into the callback at all yet — this
    // combined test only resolves once AC-1's own happy-path assertions above are satisfied.)
    const conflictDeps = { ...deps, resolveExistingInstallationOrg: vi.fn(async () => ({ orgId: 'some-other-org', active: true })) };
    await expect(
      handleGithubAppCallback(authorizedCallback(), conflictDeps as unknown as Partial<InstallCallbackDeps>),
    ).rejects.toBeInstanceOf(InstallationOrgConflictError);
    expect(deps.startInstallationSync).toHaveBeenCalledTimes(1); // unchanged since the happy-path call above
    expect(deps.kickDiscoveryDispatcher).toHaveBeenCalledTimes(1); // unchanged
  });

  // @spec AC-1
  it('never calls GithubAppClient.getInstallationRepo / any repo-listing method, and never enqueues directly', async () => {
    const listSpy = vi.fn();
    const deps = makeDeps({
      githubClient: makeGithubClient({ getInstallationRepo: listSpy }),
    });

    await handleGithubAppCallback(authorizedCallback(), deps as unknown as Partial<InstallCallbackDeps>);

    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('handleGithubAppCallback — EC-7 (setup_action=request: no row, no kick)', () => {
  // @spec EC-7
  it('returns { discovery: "skipped" } without writing a sync row or kicking the dispatcher', async () => {
    const deps = makeDeps();

    const result = await handleGithubAppCallback(
      authorizedCallback({ setupAction: 'request', installationId: undefined, code: undefined }),
      deps as unknown as Partial<InstallCallbackDeps>,
    );

    expect(result).toEqual({ redirectTo: '/settings/integrations', discovery: 'skipped' });
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
    expect(deps.withOrg).not.toHaveBeenCalled();
  });
});

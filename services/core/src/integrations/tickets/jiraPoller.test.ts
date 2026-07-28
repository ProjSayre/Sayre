// Unit tests for the Jira ticket poll cycle orchestrator. All dependencies
// are injected fakes -- no real DB, Redis, or Atlassian call -- mirroring the
// DI-with-defaults style used by jiraConnectService.test.ts /
// githubAppInstallService.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { runJiraPollCycle, type JiraPollDeps } from './jiraPoller';
import { OrgSecretUnavailableError } from './jira/orgSecrets';
import type { JiraOAuthClient } from './jira/jiraOAuthClient';

function fakeOAuthClient(searchImpl: JiraOAuthClient['searchRecentIssueKeys']): JiraOAuthClient {
  return {
    buildAuthorizeUrl: () => 'unused',
    exchangeCode: async () => {
      throw new Error('unused');
    },
    refresh: async () => {
      throw new Error('unused');
    },
    listAccessibleResources: async () => [],
    getCurrentUser: async () => {
      throw new Error('unused');
    },
    searchRecentIssueKeys: searchImpl,
  };
}

const FAKE_DB = {} as never;

describe('runJiraPollCycle', () => {
  it('fans a single org\'s recently-updated tickets out to every one of its active repos', async () => {
    const enqueue = vi.fn(async (input: { scope: { repositoryId: string }; externalTicketIds: readonly string[] }) =>
      input.externalTicketIds.map((id) => `job-${input.scope.repositoryId}-${id}`),
    );
    const deps: Partial<JiraPollDeps> = {
      getDb: async () => FAKE_DB,
      listOrgIds: async () => ['org-1'],
      listRepositories: async () => [
        { id: 'repo-a', defaultBranch: 'main' },
        { id: 'repo-b', defaultBranch: null },
      ],
      resolveContext: async () => ({
        cloudId: 'cloud-1',
        apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-1',
        siteUrl: 'https://acme.atlassian.net',
      }),
      getToken: async () => 'fresh-token',
      oauthClient: fakeOAuthClient(async () => ['PROJ-1', 'PROJ-2']),
      enqueue: enqueue as unknown as JiraPollDeps['enqueue'],
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      lookbackMs: 15 * 60 * 1000,
      onOrgError: vi.fn(),
    };

    const result = await runJiraPollCycle(deps);

    expect(result).toEqual({ orgsPolled: 1, ticketsFound: 2, jobsEnqueued: 4 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = enqueue.mock.calls.map((call) => call[0]);
    expect(firstCall.scope).toEqual({ orgId: 'org-1', repositoryId: 'repo-a', refName: 'main' });
    expect(secondCall.scope).toEqual({ orgId: 'org-1', repositoryId: 'repo-b', refName: 'main' });
    expect(firstCall.externalTicketIds).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('defaults refName to "main" when a repository has no stored default branch', async () => {
    const enqueue = vi.fn(async () => ['job-1']);
    const result = await runJiraPollCycle({
      getDb: async () => FAKE_DB,
      listOrgIds: async () => ['org-1'],
      listRepositories: async () => [{ id: 'repo-a', defaultBranch: null }],
      resolveContext: async () => ({
        cloudId: 'cloud-1',
        apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-1',
        siteUrl: 'https://acme.atlassian.net',
      }),
      getToken: async () => 'token',
      oauthClient: fakeOAuthClient(async () => ['PROJ-1']),
      enqueue: enqueue as unknown as JiraPollDeps['enqueue'],
      now: () => new Date(),
      lookbackMs: 60_000,
      onOrgError: vi.fn(),
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].scope.refName).toBe('main');
    expect(result.jobsEnqueued).toBe(1);
  });

  it('never enqueues anything for an org with no recently-updated tickets', async () => {
    const enqueue = vi.fn(async () => []);
    const listRepositories = vi.fn(async () => [{ id: 'repo-a', defaultBranch: 'main' }]);
    const result = await runJiraPollCycle({
      getDb: async () => FAKE_DB,
      listOrgIds: async () => ['org-1'],
      listRepositories: listRepositories as unknown as JiraPollDeps['listRepositories'],
      resolveContext: async () => ({
        cloudId: 'cloud-1',
        apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-1',
        siteUrl: 'https://acme.atlassian.net',
      }),
      getToken: async () => 'token',
      oauthClient: fakeOAuthClient(async () => []),
      enqueue: enqueue as unknown as JiraPollDeps['enqueue'],
      now: () => new Date(),
      lookbackMs: 60_000,
      onOrgError: vi.fn(),
    });

    expect(result).toEqual({ orgsPolled: 1, ticketsFound: 0, jobsEnqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    // Repos aren't even listed when there's nothing to fan out.
    expect(listRepositories).not.toHaveBeenCalled();
  });

  it('skips an org with no active connection without touching other orgs', async () => {
    const enqueue = vi.fn(async () => ['job-1']);
    const resolveContext = vi.fn(async (orgId: string) =>
      orgId === 'org-revoked'
        ? null
        : {
            cloudId: 'cloud-2',
            apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-2',
            siteUrl: 'https://other.atlassian.net',
          },
    );
    const result = await runJiraPollCycle({
      getDb: async () => FAKE_DB,
      listOrgIds: async () => ['org-revoked', 'org-active'],
      listRepositories: async () => [{ id: 'repo-a', defaultBranch: 'main' }],
      resolveContext: resolveContext as unknown as JiraPollDeps['resolveContext'],
      getToken: async () => 'token',
      oauthClient: fakeOAuthClient(async () => ['PROJ-1']),
      enqueue: enqueue as unknown as JiraPollDeps['enqueue'],
      now: () => new Date(),
      lookbackMs: 60_000,
      onOrgError: vi.fn(),
    });

    expect(result.orgsPolled).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].scope.orgId).toBe('org-active');
  });

  it('quietly skips an org whose token is unavailable (revoked mid-cycle) without calling onOrgError', async () => {
    const onOrgError = vi.fn();
    const enqueue = vi.fn(async () => ['job-1']);
    const result = await runJiraPollCycle({
      getDb: async () => FAKE_DB,
      listOrgIds: async () => ['org-1'],
      listRepositories: async () => [{ id: 'repo-a', defaultBranch: 'main' }],
      resolveContext: async () => ({
        cloudId: 'cloud-1',
        apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-1',
        siteUrl: 'https://acme.atlassian.net',
      }),
      getToken: async () => {
        throw new OrgSecretUnavailableError();
      },
      oauthClient: fakeOAuthClient(async () => ['PROJ-1']),
      enqueue: enqueue as unknown as JiraPollDeps['enqueue'],
      now: () => new Date(),
      lookbackMs: 60_000,
      onOrgError,
    });

    expect(result).toEqual({ orgsPolled: 1, ticketsFound: 0, jobsEnqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(onOrgError).not.toHaveBeenCalled();
  });

  it('reports an unexpected per-org failure via onOrgError and continues to the next org', async () => {
    const onOrgError = vi.fn();
    const enqueue = vi.fn(async () => ['job-1']);
    const resolveContext = vi.fn(async (orgId: string) => {
      if (orgId === 'org-broken') throw new Error('boom');
      return {
        cloudId: 'cloud-2',
        apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-2',
        siteUrl: 'https://other.atlassian.net',
      };
    });
    const result = await runJiraPollCycle({
      getDb: async () => FAKE_DB,
      listOrgIds: async () => ['org-broken', 'org-ok'],
      listRepositories: async () => [{ id: 'repo-a', defaultBranch: 'main' }],
      resolveContext: resolveContext as unknown as JiraPollDeps['resolveContext'],
      getToken: async () => 'token',
      oauthClient: fakeOAuthClient(async () => ['PROJ-1']),
      enqueue: enqueue as unknown as JiraPollDeps['enqueue'],
      now: () => new Date(),
      lookbackMs: 60_000,
      onOrgError,
    });

    expect(onOrgError).toHaveBeenCalledTimes(1);
    expect(onOrgError.mock.calls[0][0]).toBe('org-broken');
    expect(result.orgsPolled).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].scope.orgId).toBe('org-ok');
  });

  it('passes a since date computed from now() - lookbackMs to the search call', async () => {
    let capturedSince: Date | null = null;
    const result = await runJiraPollCycle({
      getDb: async () => FAKE_DB,
      listOrgIds: async () => ['org-1'],
      listRepositories: async () => [],
      resolveContext: async () => ({
        cloudId: 'cloud-1',
        apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-1',
        siteUrl: 'https://acme.atlassian.net',
      }),
      getToken: async () => 'token',
      oauthClient: fakeOAuthClient(async (_token, _base, since) => {
        capturedSince = since;
        return [];
      }),
      enqueue: (async () => []) as unknown as JiraPollDeps['enqueue'],
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      lookbackMs: 5 * 60 * 1000,
      onOrgError: vi.fn(),
    });

    expect(capturedSince).toEqual(new Date('2026-07-27T11:55:00.000Z'));
    expect(result.orgsPolled).toBe(1);
  });
});

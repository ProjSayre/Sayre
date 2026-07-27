// Unit tests for the org-scoped credential loader: freshness/skew, the
// concurrency-safe refresh path (via a FAKE JiraConnectionStore whose
// withLockedActiveConnection genuinely serializes concurrent callers with a
// promise chain, exactly mirroring what a real Postgres `SELECT ... FOR
// UPDATE` does — this directly exercises orgSecrets.ts's re-check-under-lock
// logic, not just the store's SQL), invalid_grant revocation, and transient
// failure (no revoke). No real DB, no real Atlassian endpoint.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import type {
  JiraConnectionRow,
  JiraConnectionStatusView,
  JiraConnectionStore,
  LockedJiraConnection,
  RefreshJiraTokensInput,
} from '../../../db/jiraConnectionStore';
import {
  JiraRefreshInvalidGrantError,
  type JiraOAuthClient,
  type JiraTokenSet,
} from './jiraOAuthClient';
import {
  getOrgSecret,
  OrgSecretUnavailableError,
  resetJiraOrgSecretsDependenciesForTests,
  resolveJiraConnectionContext,
  setJiraOrgSecretsDependenciesForTests,
} from './orgSecrets';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function makeRow(overrides: Partial<JiraConnectionRow> = {}): JiraConnectionRow {
  return {
    id: 'conn-1',
    orgId: ORG_A,
    cloudId: 'cloud-a',
    siteUrl: 'https://a.atlassian.net',
    siteName: 'A',
    accessToken: 'access-current',
    refreshToken: 'refresh-current',
    accessTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // fresh (10 min out)
    scopes: 'read:jira-work',
    connectedByUserId: 'user-1',
    connectedByLabel: 'Alex Kwon',
    connectedByAccountId: 'acc-1',
    lastSyncedAt: null,
    connectedAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

/**
 * Fake store whose `withLockedActiveConnection` genuinely SERIALIZES
 * concurrent calls via a promise chain (the same causal ordering a real
 * Postgres `SELECT ... FOR UPDATE` produces): the second concurrent caller's
 * callback only starts after the first's completes and has already mutated
 * `current`, so a correct re-check-under-lock skips the second refresh. A
 * store that did NOT serialize (or that let the re-check run against a STALE
 * snapshot) would call `refresh()` twice here, which is exactly the
 * double-spend bug this test exists to catch.
 */
function makeFakeStore(initialRow: JiraConnectionRow | null) {
  let current: JiraConnectionRow | null = initialRow;
  let lockChain: Promise<unknown> = Promise.resolve();
  const resolveActiveCalls: string[] = [];
  const lockedCalls: string[] = [];

  const store: JiraConnectionStore = {
    async connect(): Promise<JiraConnectionStatusView> {
      throw new Error('not used in this test');
    },
    async resolveActive(orgId: string): Promise<JiraConnectionRow | null> {
      resolveActiveCalls.push(orgId);
      return current && current.orgId === orgId ? current : null;
    },
    async refreshTokens(): Promise<void> {
      throw new Error('not used in this test (orgSecrets uses withLockedActiveConnection)');
    },
    async softRevoke(): Promise<JiraConnectionStatusView | null> {
      throw new Error('not used in this test');
    },
    async touchLastSynced(): Promise<void> {},
    async statusView(): Promise<JiraConnectionStatusView | null> {
      throw new Error('not used in this test');
    },
    async withLockedActiveConnection<T>(
      orgId: string,
      fn: (locked: LockedJiraConnection) => Promise<T>,
    ): Promise<T | null> {
      lockedCalls.push(orgId);
      const run: Promise<T | null> = lockChain.then(async () => {
        if (current === null || current.orgId !== orgId) return null;
        const locked: LockedJiraConnection = {
          row: current,
          persistRefresh: async (next: RefreshJiraTokensInput) => {
            current = {
              ...current!,
              accessToken: next.accessToken,
              refreshToken: next.refreshToken,
              accessTokenExpiresAt: next.accessTokenExpiresAt,
              scopes: next.scopes,
            };
          },
          revoke: async () => {
            current = current ? { ...current, revokedAt: new Date() } : null;
          },
        };
        return fn(locked);
      });
      // Chain even a rejected attempt so the "lock" is always released for
      // the next waiter (mirrors a real transaction rolling back).
      lockChain = run.catch(() => undefined);
      return run;
    },
  };

  return {
    store,
    getCurrentRow: () => current,
    resolveActiveCalls,
    lockedCalls,
  };
}

function makeFakeOAuthClient(
  overrides: Partial<JiraOAuthClient> = {},
): JiraOAuthClient {
  return {
    buildAuthorizeUrl: () => 'https://auth.atlassian.test/authorize',
    exchangeCode: async () => {
      throw new Error('not used in this test');
    },
    refresh: async () => {
      throw new Error('refresh not stubbed for this test');
    },
    listAccessibleResources: async () => [],
    getCurrentUser: async () => {
      throw new Error('not used in this test');
    },
    ...overrides,
  };
}

beforeEach(() => {
  setConfigOverrideForTests('JIRA_OAUTH_API_BASE_URL', 'https://api.atlassian.test');
});

afterEach(() => {
  resetJiraOrgSecretsDependenciesForTests();
  resetConfigForTests();
  vi.restoreAllMocks();
});

describe('resolveJiraConnectionContext', () => {
  it('returns null when there is no active connection', async () => {
    const { store } = makeFakeStore(null);
    setJiraOrgSecretsDependenciesForTests({ store });
    expect(await resolveJiraConnectionContext(ORG_A)).toBeNull();
  });

  it('returns the per-org API gateway base + site URL for an active connection', async () => {
    const { store } = makeFakeStore(makeRow());
    setJiraOrgSecretsDependenciesForTests({ store });
    const ctx = await resolveJiraConnectionContext(ORG_A);
    expect(ctx).toEqual({
      cloudId: 'cloud-a',
      apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-a',
      siteUrl: 'https://a.atlassian.net',
    });
  });

  it('never returns a token or ciphertext (metadata only)', async () => {
    const { store } = makeFakeStore(makeRow());
    setJiraOrgSecretsDependenciesForTests({ store });
    const ctx = await resolveJiraConnectionContext(ORG_A);
    expect(JSON.stringify(ctx)).not.toContain('access-current');
    expect(JSON.stringify(ctx)).not.toContain('refresh-current');
  });
});

describe('getOrgSecret — freshness / no-op path', () => {
  it('returns the current access token without refreshing when it is well outside the skew window', async () => {
    const { store, lockedCalls } = makeFakeStore(makeRow());
    const oauthClient = makeFakeOAuthClient({
      refresh: vi.fn(async () => {
        throw new Error('refresh must NOT be called for a fresh token');
      }),
    });
    setJiraOrgSecretsDependenciesForTests({ store, oauthClient });

    const token = await getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN');

    expect(token).toBe('access-current');
    expect(lockedCalls).toHaveLength(0);
  });

  it('throws OrgSecretUnavailableError when there is no active connection (never calls the lock path)', async () => {
    const { store, lockedCalls } = makeFakeStore(null);
    setJiraOrgSecretsDependenciesForTests({ store });
    await expect(getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN')).rejects.toBeInstanceOf(
      OrgSecretUnavailableError,
    );
    expect(lockedCalls).toHaveLength(0);
  });
});

describe('getOrgSecret — silent refresh (single caller)', () => {
  it('refreshes when the token is within the 60s skew window, persists the ROTATED tokens, and returns the new access token', async () => {
    const nearExpiry = makeRow({
      accessTokenExpiresAt: new Date(Date.now() + 30_000), // 30s out < 60s skew
    });
    const { store, getCurrentRow } = makeFakeStore(nearExpiry);
    const refresh = vi.fn(
      async (): Promise<JiraTokenSet> => ({
        accessToken: 'access-ROTATED',
        refreshToken: 'refresh-ROTATED',
        expiresInSeconds: 3600,
        scope: 'read:jira-work',
      }),
    );
    setJiraOrgSecretsDependenciesForTests({ store, oauthClient: makeFakeOAuthClient({ refresh }) });

    const token = await getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN');

    expect(token).toBe('access-ROTATED');
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith('refresh-current');
    // The rotated REFRESH token (not the old one) must be what's persisted —
    // a repeat of the old, now-invalidated refresh token would break the
    // NEXT refresh with invalid_grant.
    expect(getCurrentRow()?.refreshToken).toBe('refresh-ROTATED');
    expect(getCurrentRow()?.accessToken).toBe('access-ROTATED');
  });

  it('refreshes when the token is already expired', async () => {
    const expired = makeRow({ accessTokenExpiresAt: new Date(Date.now() - 1000) });
    const { store } = makeFakeStore(expired);
    const refresh = vi.fn(
      async (): Promise<JiraTokenSet> => ({
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        expiresInSeconds: 3600,
        scope: 'read:jira-work',
      }),
    );
    setJiraOrgSecretsDependenciesForTests({ store, oauthClient: makeFakeOAuthClient({ refresh }) });

    expect(await getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN')).toBe('access-new');
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('getOrgSecret — concurrent same-org refresh (the double-spend race)', () => {
  it(
    'two concurrent calls for the same org both see a near-expiry token: exactly ONE network refresh ' +
      'happens; the second re-reads under the lock and reuses the rotated token instead of spending ' +
      "the (single-use) refresh token a second time (which would 400 invalid_grant against a real Atlassian)",
    async () => {
      const nearExpiry = makeRow({ accessTokenExpiresAt: new Date(Date.now() + 10_000) });
      const { store } = makeFakeStore(nearExpiry);

      let refreshCallCount = 0;
      const refresh = vi.fn(async (refreshToken: string): Promise<JiraTokenSet> => {
        refreshCallCount += 1;
        if (refreshCallCount > 1) {
          // A real Atlassian server would 400 invalid_grant on the second use
          // of the same refresh token. Fail the test loudly if orgSecrets.ts
          // ever lets this happen.
          throw new Error(
            `refresh() called a second time with refreshToken=${refreshToken} — double-spend!`,
          );
        }
        // Simulate real network latency so both concurrent callers are
        // definitely in flight before either resolves.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          accessToken: 'access-ROTATED-ONCE',
          refreshToken: 'refresh-ROTATED-ONCE',
          expiresInSeconds: 3600,
          scope: 'read:jira-work',
        };
      });
      setJiraOrgSecretsDependenciesForTests({ store, oauthClient: makeFakeOAuthClient({ refresh }) });

      const [tokenA, tokenB] = await Promise.all([
        getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN'),
        getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN'),
      ]);

      expect(refresh).toHaveBeenCalledOnce();
      expect(tokenA).toBe('access-ROTATED-ONCE');
      expect(tokenB).toBe('access-ROTATED-ONCE');
    },
  );

  it('cross-org concurrency: a concurrent refresh for org B does not affect org A\'s lock/refresh at all', async () => {
    const rowA = makeRow({ orgId: ORG_A, accessTokenExpiresAt: new Date(Date.now() + 10_000) });
    const rowB = makeRow({
      orgId: ORG_B,
      cloudId: 'cloud-b',
      siteUrl: 'https://b.atlassian.net',
      accessToken: 'access-b-current',
      refreshToken: 'refresh-b-current',
      accessTokenExpiresAt: new Date(Date.now() + 10_000),
    });
    // Two independent fake stores (one per org) wired to the SAME orgSecrets
    // module-level singleton via a dispatching wrapper, so a real cross-org
    // race is exercised through the actual getOrgSecret() call sites.
    const storeA = makeFakeStore(rowA);
    const storeB = makeFakeStore(rowB);
    const dispatch: JiraConnectionStore = {
      connect: storeA.store.connect,
      resolveActive: (orgId) =>
        orgId === ORG_A ? storeA.store.resolveActive(orgId) : storeB.store.resolveActive(orgId),
      refreshTokens: storeA.store.refreshTokens,
      softRevoke: storeA.store.softRevoke,
      touchLastSynced: async () => {},
      statusView: storeA.store.statusView,
      withLockedActiveConnection: (orgId, fn) =>
        orgId === ORG_A
          ? storeA.store.withLockedActiveConnection(orgId, fn)
          : storeB.store.withLockedActiveConnection(orgId, fn),
    };

    let refreshCallsA = 0;
    let refreshCallsB = 0;
    const oauthClient = makeFakeOAuthClient({
      refresh: vi.fn(async (refreshToken: string): Promise<JiraTokenSet> => {
        if (refreshToken === 'refresh-current') refreshCallsA += 1;
        if (refreshToken === 'refresh-b-current') refreshCallsB += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          accessToken: `rotated-for-${refreshToken}`,
          refreshToken: `rotated-refresh-for-${refreshToken}`,
          expiresInSeconds: 3600,
          scope: 'read:jira-work',
        };
      }),
    });
    setJiraOrgSecretsDependenciesForTests({ store: dispatch, oauthClient });

    const [tokenA, tokenB] = await Promise.all([
      getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN'),
      getOrgSecret(ORG_B, 'JIRA_ACCESS_TOKEN'),
    ]);

    expect(refreshCallsA).toBe(1);
    expect(refreshCallsB).toBe(1);
    expect(tokenA).toBe('rotated-for-refresh-current');
    expect(tokenB).toBe('rotated-for-refresh-b-current');
    expect(storeA.getCurrentRow()?.accessToken).toBe('rotated-for-refresh-current');
    expect(storeB.getCurrentRow()?.accessToken).toBe('rotated-for-refresh-b-current');
  });
});

describe('getOrgSecret — refresh failure modes', () => {
  it('invalid_grant: soft-revokes the connection and throws OrgSecretUnavailableError', async () => {
    const nearExpiry = makeRow({ accessTokenExpiresAt: new Date(Date.now() + 1000) });
    const { store, getCurrentRow } = makeFakeStore(nearExpiry);
    const refresh = vi.fn(async () => {
      throw new JiraRefreshInvalidGrantError();
    });
    setJiraOrgSecretsDependenciesForTests({ store, oauthClient: makeFakeOAuthClient({ refresh }) });

    await expect(getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN')).rejects.toBeInstanceOf(
      OrgSecretUnavailableError,
    );
    expect(getCurrentRow()?.revokedAt).not.toBeNull();
  });

  it('transient upstream failure (5xx-equivalent): throws OrgSecretUnavailableError WITHOUT revoking', async () => {
    const nearExpiry = makeRow({ accessTokenExpiresAt: new Date(Date.now() + 1000) });
    const { store, getCurrentRow } = makeFakeStore(nearExpiry);
    const refresh = vi.fn(async () => {
      throw new Error('upstream 503');
    });
    setJiraOrgSecretsDependenciesForTests({ store, oauthClient: makeFakeOAuthClient({ refresh }) });

    await expect(getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN')).rejects.toBeInstanceOf(
      OrgSecretUnavailableError,
    );
    expect(getCurrentRow()?.revokedAt).toBeNull();
    expect(getCurrentRow()?.accessToken).toBe('access-current'); // untouched
  });

  it('never leaks which failure occurred (invalid_grant vs transient) in the thrown message', async () => {
    const nearExpiry = makeRow({ accessTokenExpiresAt: new Date(Date.now() + 1000) });
    const { store: storeInvalid } = makeFakeStore(nearExpiry);
    setJiraOrgSecretsDependenciesForTests({
      store: storeInvalid,
      oauthClient: makeFakeOAuthClient({
        refresh: async () => {
          throw new JiraRefreshInvalidGrantError();
        },
      }),
    });
    let invalidGrantMessage = '';
    try {
      await getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN');
    } catch (error) {
      invalidGrantMessage = error instanceof Error ? error.message : String(error);
    }

    resetJiraOrgSecretsDependenciesForTests();
    const { store: storeTransient } = makeFakeStore(makeRow({ accessTokenExpiresAt: new Date(Date.now() + 1000) }));
    setJiraOrgSecretsDependenciesForTests({
      store: storeTransient,
      oauthClient: makeFakeOAuthClient({
        refresh: async () => {
          throw new Error('upstream 503');
        },
      }),
    });
    let transientMessage = '';
    try {
      await getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN');
    } catch (error) {
      transientMessage = error instanceof Error ? error.message : String(error);
    }

    expect(invalidGrantMessage).toBe(transientMessage);
    expect(invalidGrantMessage).not.toContain('access-current');
    expect(invalidGrantMessage).not.toContain('refresh-current');
  });

  it('connection revoked between resolveActive and the lock acquisition -> OrgSecretUnavailableError, not a crash', async () => {
    const nearExpiry = makeRow({ accessTokenExpiresAt: new Date(Date.now() + 1000) });
    const { store } = makeFakeStore(nearExpiry);
    // Simulate a disconnect racing in right as getOrgSecret decides to refresh:
    // override withLockedActiveConnection to behave as if the row vanished.
    const racedStore: JiraConnectionStore = {
      ...store,
      withLockedActiveConnection: async () => null,
    };
    setJiraOrgSecretsDependenciesForTests({ store: racedStore });
    await expect(getOrgSecret(ORG_A, 'JIRA_ACCESS_TOKEN')).rejects.toBeInstanceOf(
      OrgSecretUnavailableError,
    );
  });
});

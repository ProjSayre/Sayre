// Fully DI-mocked unit tests for startJiraConnect / handleJiraCallback /
// getJiraConnectionStatus / disconnectJira — no real Atlassian API, no
// Postgres. Mirrors the DI-mock pattern in githubAppInstallService.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { JiraConnectStateError, type JiraConnectState } from '../integrations/tickets/jira/jiraConnectState';
import type {
  JiraAccessibleResource,
  JiraOAuthClient,
  JiraOAuthUser,
  JiraTokenSet,
} from '../integrations/tickets/jira/jiraOAuthClient';
import type { JiraConnectionStatusView, JiraConnectionStore } from '../db/jiraConnectionStore';
import {
  disconnectJira,
  getJiraConnectionStatus,
  handleJiraCallback,
  JiraCallbackBadRequestError,
  JiraOAuthUpstreamError,
  JiraSingleSiteRequiredError,
  resolveConnectingUserLabel,
  startJiraConnect,
  type JiraConnectServiceDeps,
} from './jiraConnectService';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

beforeEach(() => {
  setConfigOverrideForTests('JIRA_POST_CONNECT_REDIRECT_URL', '/settings/integrations');
});

afterEach(() => {
  resetConfigForTests();
});

function makeState(overrides: Partial<JiraConnectState> = {}): JiraConnectState {
  return {
    org_id: ORG_A,
    user_id: 'user-1',
    user_label: 'Alex Kwon',
    nonce: 'nonce-1',
    purpose: 'jira_oauth_connect',
    ...overrides,
  };
}

function makeResource(overrides: Partial<JiraAccessibleResource> = {}): JiraAccessibleResource {
  return {
    id: 'cloud-1',
    url: 'https://acme.atlassian.net',
    name: 'Acme',
    scopes: ['read:jira-work'],
    ...overrides,
  };
}

function makeTokenSet(overrides: Partial<JiraTokenSet> = {}): JiraTokenSet {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresInSeconds: 3600,
    scope: 'read:jira-work',
    ...overrides,
  };
}

function makeUser(overrides: Partial<JiraOAuthUser> = {}): JiraOAuthUser {
  return { accountId: 'account-1', email: 'alex@example.com', name: 'Alex Kwon', ...overrides };
}

function makeOAuthClient(overrides: Partial<JiraOAuthClient> = {}): JiraOAuthClient {
  return {
    buildAuthorizeUrl: vi.fn(({ state }) => `https://auth.atlassian.test/authorize?state=${encodeURIComponent(state)}`),
    exchangeCode: vi.fn(async () => makeTokenSet()),
    refresh: vi.fn(async () => makeTokenSet()),
    listAccessibleResources: vi.fn(async () => [makeResource()]),
    getCurrentUser: vi.fn(async () => makeUser()),
    ...overrides,
  };
}

function makeStore(overrides: Partial<JiraConnectionStore> = {}): JiraConnectionStore {
  return {
    connect: vi.fn(async (): Promise<JiraConnectionStatusView> => ({
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      siteName: 'Acme',
      connectedByLabel: 'Alex Kwon',
      connectedByAccountId: 'account-1',
      lastSyncedAt: null,
      connectedAt: new Date('2026-07-24T00:00:00Z'),
    })),
    resolveActive: vi.fn(async () => null),
    refreshTokens: vi.fn(async () => undefined),
    softRevoke: vi.fn(async () => null),
    touchLastSynced: vi.fn(async () => undefined),
    statusView: vi.fn(async () => null),
    withLockedActiveConnection: vi.fn(async () => null),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<JiraConnectServiceDeps> = {}): JiraConnectServiceDeps {
  return {
    signState: vi.fn(async ({ orgId }) => `signed-state-for-${orgId}`),
    verifyState: vi.fn(async () => makeState()),
    oauthClient: makeOAuthClient(),
    store: makeStore(),
    resolveUserLabel: vi.fn(async () => 'Alex Kwon'),
    ...overrides,
  };
}

describe('startJiraConnect', () => {
  it('signs a state binding the SERVER-resolved org/user/label, then redirects to the Atlassian authorize URL', async () => {
    const deps = makeDeps();
    const result = await startJiraConnect(
      { orgId: ORG_A, userId: 'user-1', userLabel: 'Alex Kwon' },
      deps,
    );
    expect(deps.signState).toHaveBeenCalledWith({ orgId: ORG_A, userId: 'user-1', userLabel: 'Alex Kwon' });
    expect(result.redirectTo).toContain('auth.atlassian.test/authorize');
    expect(result.redirectTo).toContain(encodeURIComponent(`signed-state-for-${ORG_A}`));
  });
});

describe('resolveConnectingUserLabel', () => {
  it('resolves through the injected store lookup', async () => {
    const resolveUserLabel = vi.fn(async () => 'Jordan Lee');
    const label = await resolveConnectingUserLabel({ orgId: ORG_A, userId: 'user-9' }, { resolveUserLabel });
    expect(label).toBe('Jordan Lee');
    expect(resolveUserLabel).toHaveBeenCalledWith(ORG_A, 'user-9');
  });

  it('falls back to a generic label when the user record is gone (deleted user)', async () => {
    const resolveUserLabel = vi.fn(async () => null);
    const label = await resolveConnectingUserLabel({ orgId: ORG_A, userId: 'user-9' }, { resolveUserLabel });
    expect(label).toBe('Sayre administrator');
  });
});

describe('handleJiraCallback — OAuth/callback input edge cases', () => {
  it('missing code -> JiraCallbackBadRequestError, nothing exchanged/stored', async () => {
    const deps = makeDeps();
    await expect(
      handleJiraCallback({ state: 'x' }, deps),
    ).rejects.toBeInstanceOf(JiraCallbackBadRequestError);
    expect(deps.oauthClient.exchangeCode).not.toHaveBeenCalled();
    expect(deps.store.connect).not.toHaveBeenCalled();
  });

  it('empty-string code -> JiraCallbackBadRequestError', async () => {
    const deps = makeDeps();
    await expect(
      handleJiraCallback({ state: 'x', code: '   ' }, deps),
    ).rejects.toBeInstanceOf(JiraCallbackBadRequestError);
  });

  it('missing state -> JiraCallbackBadRequestError, verifyState never called with undefined, exchange never happens', async () => {
    const deps = makeDeps();
    await expect(
      handleJiraCallback({ code: 'abc' }, deps),
    ).rejects.toBeInstanceOf(JiraCallbackBadRequestError);
    expect(deps.oauthClient.exchangeCode).not.toHaveBeenCalled();
  });

  it('empty-string state -> JiraCallbackBadRequestError', async () => {
    const deps = makeDeps();
    await expect(
      handleJiraCallback({ code: 'abc', state: '' }, deps),
    ).rejects.toBeInstanceOf(JiraCallbackBadRequestError);
  });

  it('tampered/expired/malformed state (verifyState throws JiraConnectStateError) -> uniform 400, no leak of which check failed', async () => {
    const deps = makeDeps({
      verifyState: vi.fn(async () => {
        throw new JiraConnectStateError();
      }),
    });
    await expect(
      handleJiraCallback({ code: 'abc', state: 'bad' }, deps),
    ).rejects.toBeInstanceOf(JiraCallbackBadRequestError);
    expect(deps.oauthClient.exchangeCode).not.toHaveBeenCalled();
  });

  it('a wrong-purpose token rejected upstream by verifyState (real cross-family check lives in jiraConnectState.test.ts) surfaces as 400 here too', async () => {
    const deps = makeDeps({
      verifyState: vi.fn(async () => {
        throw new JiraConnectStateError('wrong purpose');
      }),
    });
    await expect(
      handleJiraCallback({ code: 'abc', state: 'github-install-state-token' }, deps),
    ).rejects.toBeInstanceOf(JiraCallbackBadRequestError);
  });

  it('a non-JiraConnectStateError failure from verifyState propagates uncaught (infra failure, not a 400)', async () => {
    const deps = makeDeps({
      verifyState: vi.fn(async () => {
        throw new Error('secret loader down');
      }),
    });
    await expect(handleJiraCallback({ code: 'abc', state: 'x' }, deps)).rejects.toThrow(
      'secret loader down',
    );
  });

  it('Atlassian ?error=access_denied (user declined consent) -> redirects with a cancelled flag, stores nothing, never exchanges', async () => {
    const deps = makeDeps();
    const result = await handleJiraCallback({ error: 'access_denied' }, deps);
    expect(result.redirectTo).toBe('/settings/integrations?jira_error=cancelled');
    expect(deps.verifyState).not.toHaveBeenCalled();
    expect(deps.oauthClient.exchangeCode).not.toHaveBeenCalled();
    expect(deps.store.connect).not.toHaveBeenCalled();
  });

  it('code exchange upstream failure -> JiraOAuthUpstreamError, nothing stored', async () => {
    const deps = makeDeps({
      oauthClient: makeOAuthClient({
        exchangeCode: vi.fn(async () => {
          throw new Error('network error / 5xx');
        }),
      }),
    });
    await expect(
      handleJiraCallback({ code: 'abc', state: 'x' }, deps),
    ).rejects.toBeInstanceOf(JiraOAuthUpstreamError);
    expect(deps.store.connect).not.toHaveBeenCalled();
  });

  it('accessible-resources returns 0 sites -> no_site redirect, nothing stored', async () => {
    const deps = makeDeps({
      oauthClient: makeOAuthClient({ listAccessibleResources: vi.fn(async () => []) }),
    });
    const result = await handleJiraCallback({ code: 'abc', state: 'x' }, deps);
    expect(result.redirectTo).toBe('/settings/integrations?jira_error=no_site');
    expect(deps.store.connect).not.toHaveBeenCalled();
  });

  it('accessible-resources returns >1 site -> JiraSingleSiteRequiredError with an actionable message, nothing stored (OQ-3)', async () => {
    const deps = makeDeps({
      oauthClient: makeOAuthClient({
        listAccessibleResources: vi.fn(async () => [
          makeResource({ id: 'cloud-1' }),
          makeResource({ id: 'cloud-2' }),
        ]),
      }),
    });
    await expect(
      handleJiraCallback({ code: 'abc', state: 'x' }, deps),
    ).rejects.toBeInstanceOf(JiraSingleSiteRequiredError);
    expect(deps.store.connect).not.toHaveBeenCalled();
    expect(deps.oauthClient.getCurrentUser).not.toHaveBeenCalled();
  });

  it('accessible-resources upstream failure -> JiraOAuthUpstreamError, nothing stored', async () => {
    const deps = makeDeps({
      oauthClient: makeOAuthClient({
        listAccessibleResources: vi.fn(async () => {
          throw new Error('502 from Atlassian');
        }),
      }),
    });
    await expect(
      handleJiraCallback({ code: 'abc', state: 'x' }, deps),
    ).rejects.toBeInstanceOf(JiraOAuthUpstreamError);
    expect(deps.store.connect).not.toHaveBeenCalled();
  });

  it('getCurrentUser failure -> treated as upstream failure (502), NOT a completed connection; nothing stored', async () => {
    const deps = makeDeps({
      oauthClient: makeOAuthClient({
        getCurrentUser: vi.fn(async () => {
          throw new Error('/me request failed');
        }),
      }),
    });
    await expect(
      handleJiraCallback({ code: 'abc', state: 'x' }, deps),
    ).rejects.toBeInstanceOf(JiraOAuthUpstreamError);
    expect(deps.store.connect).not.toHaveBeenCalled();
  });
});

describe('handleJiraCallback — happy path', () => {
  it('persists the connection using org_id/user_id/user_label from STATE ONLY (never a client-supplied field)', async () => {
    const deps = makeDeps({
      verifyState: vi.fn(async () => makeState({ org_id: ORG_A, user_id: 'user-1', user_label: 'Alex Kwon' })),
    });
    const forgedInput = {
      code: 'abc',
      state: 'x',
      // A forged org_id-shaped field that a naive implementation might read.
      org_id: 'attacker-org',
    } as unknown as Parameters<typeof handleJiraCallback>[0];

    const result = await handleJiraCallback(forgedInput, deps);

    expect(result.redirectTo).toBe('/settings/integrations');
    expect(deps.store.connect).toHaveBeenCalledWith(
      ORG_A,
      expect.objectContaining({
        cloudId: 'cloud-1',
        siteUrl: 'https://acme.atlassian.net',
        siteName: 'Acme',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        connectedByUserId: 'user-1',
        connectedByLabel: 'Alex Kwon',
        connectedByAccountId: 'account-1',
      }),
    );
    expect(deps.store.connect).not.toHaveBeenCalledWith('attacker-org', expect.anything());
  });

  it('site name defaults to null when Atlassian returns an empty name', async () => {
    const deps = makeDeps({
      oauthClient: makeOAuthClient({ listAccessibleResources: vi.fn(async () => [makeResource({ name: '' })]) }),
    });
    await handleJiraCallback({ code: 'abc', state: 'x' }, deps);
    expect(deps.store.connect).toHaveBeenCalledWith(
      ORG_A,
      expect.objectContaining({ siteName: null }),
    );
  });
});

describe('getJiraConnectionStatus', () => {
  it('returns the server-filtered status view for the given org (no token, no cloudId)', async () => {
    const view: JiraConnectionStatusView = {
      connected: true,
      siteUrl: 'https://acme.atlassian.net',
      siteName: 'Acme',
      connectedByLabel: 'Alex Kwon',
      connectedByAccountId: 'account-1',
      lastSyncedAt: new Date('2026-07-24T00:00:00Z'),
      connectedAt: new Date('2026-07-20T00:00:00Z'),
    };
    const deps = makeDeps({ store: makeStore({ statusView: vi.fn(async () => view) }) });
    const result = await getJiraConnectionStatus({ orgId: ORG_A }, deps);
    expect(result.authorization).toBe('server-filtered');
    expect(result.connection).toEqual(view);
    expect(JSON.stringify(result)).not.toContain('cloud-');
  });

  it('returns connection: null when the org has never connected', async () => {
    const deps = makeDeps({ store: makeStore({ statusView: vi.fn(async () => null) }) });
    const result = await getJiraConnectionStatus({ orgId: ORG_B }, deps);
    expect(result.connection).toBeNull();
  });

  it('cross-org isolation: org A status never queries using org B\'s id', async () => {
    const statusView = vi.fn(async (orgId: string) => (orgId === ORG_A ? null : null));
    const deps = makeDeps({ store: makeStore({ statusView }) });
    await getJiraConnectionStatus({ orgId: ORG_A }, deps);
    expect(statusView).toHaveBeenCalledWith(ORG_A);
    expect(statusView).not.toHaveBeenCalledWith(ORG_B);
  });
});

describe('disconnectJira', () => {
  it('soft-revokes only the target org and returns its updated (disconnected) status view', async () => {
    const softRevoke = vi.fn(async () => null);
    const statusView = vi.fn(async () => null);
    const deps = makeDeps({ store: makeStore({ softRevoke, statusView }) });

    const result = await disconnectJira({ orgId: ORG_A, actorUserId: 'user-1', actorLabel: 'Alex Kwon' }, deps);

    expect(softRevoke).toHaveBeenCalledWith(ORG_A, 'user-1', 'Alex Kwon');
    expect(softRevoke).not.toHaveBeenCalledWith(ORG_B, expect.anything(), expect.anything());
    expect(result.connection).toBeNull();
  });
});

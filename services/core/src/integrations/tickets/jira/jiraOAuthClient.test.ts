// Unit tests for the concrete Atlassian 3LO client returned by
// createDefaultJiraOAuthClient().
//
// NOTE (gap worth flagging to review): spec.md says "Inject `fetch` for
// tests," and the internal `AtlassianJiraOAuthClient` class constructor DOES
// accept an injectable fetcher — but neither that class nor a factory
// accepting a custom fetcher is exported. `createDefaultJiraOAuthClient()`
// always wraps the real global `fetch`. This does not block callers that
// inject through the `JiraOAuthClient` *interface* (jiraConnectService.ts,
// orgSecrets.ts both accept `oauthClient: JiraOAuthClient` via DI and are
// tested against hand-rolled fakes, not this concrete class) — but it does
// mean the concrete Atlassian wire-format behavior (URL shape, error
// mapping, response parsing) can only be exercised here by stubbing the
// global `fetch`, since no exported seam accepts a custom one directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, resetSecretsForTests, setConfigOverrideForTests, setSecretBackendForTests } from '@sayre/config';
import {
  createDefaultJiraOAuthClient,
  JiraOAuthError,
  JiraRefreshInvalidGrantError,
  type JiraOAuthClient,
} from './jiraOAuthClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let client: JiraOAuthClient;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setConfigOverrideForTests('JIRA_OAUTH_AUTHORIZE_URL', 'https://auth.atlassian.test/authorize');
  setConfigOverrideForTests('JIRA_OAUTH_TOKEN_URL', 'https://auth.atlassian.test/oauth/token');
  setConfigOverrideForTests('JIRA_OAUTH_API_BASE_URL', 'https://api.atlassian.test');
  setConfigOverrideForTests('JIRA_OAUTH_SCOPES', 'read:jira-work write:jira-work read:me offline_access');
  setConfigOverrideForTests('JIRA_OAUTH_CLIENT_ID', 'client-abc');
  setConfigOverrideForTests('JIRA_OAUTH_CALLBACK_URL', 'https://core.test/integrations/jira/callback');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JIRA_OAUTH_CLIENT_SECRET') return 'client-secret-xyz';
    throw new Error(`unexpected secret ref: ${ref}`);
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  client = createDefaultJiraOAuthClient();
});

afterEach(() => {
  resetConfigForTests();
  resetSecretsForTests();
  vi.unstubAllGlobals();
});

describe('buildAuthorizeUrl', () => {
  it('builds the exact literal query shape from spec.md (space-as-%20, unencoded client_id)', () => {
    const url = client.buildAuthorizeUrl({ state: 'signed.state.token' });
    expect(url).toBe(
      'https://auth.atlassian.test/authorize?audience=api.atlassian.com&client_id=client-abc' +
        '&scope=read%3Ajira-work%20write%3Ajira-work%20read%3Ame%20offline_access' +
        '&redirect_uri=https%3A%2F%2Fcore.test%2Fintegrations%2Fjira%2Fcallback' +
        '&state=signed.state.token&response_type=code&prompt=consent',
    );
  });

  it('URL-encodes special characters in the state token', () => {
    const url = client.buildAuthorizeUrl({ state: 'a.b+c/d=&x' });
    expect(url).toContain(`state=${encodeURIComponent('a.b+c/d=&x')}`);
    expect(url).not.toContain('state=a.b+c/d=&x');
  });
});

describe('exchangeCode', () => {
  it('POSTs the authorization_code grant with client_id/client_secret and returns the parsed token set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'read:jira-work',
      }),
    );

    const result = await client.exchangeCode('one-time-code');

    expect(result).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresInSeconds: 3600,
      scope: 'read:jira-work',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.atlassian.test/oauth/token');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      grant_type: 'authorization_code',
      code: 'one-time-code',
      redirect_uri: 'https://core.test/integrations/jira/callback',
      client_id: 'client-abc',
      client_secret: 'client-secret-xyz',
    });
  });

  it('throws JiraOAuthError (not the rotation-specific error) on a non-400 upstream failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(client.exchangeCode('code')).rejects.toBeInstanceOf(JiraOAuthError);
  });

  it('throws JiraOAuthError on a network failure (fetch rejects)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(client.exchangeCode('code')).rejects.toBeInstanceOf(JiraOAuthError);
  });

  it('throws JiraOAuthError when the token response is malformed (missing fields)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'only-one-field' }));
    await expect(client.exchangeCode('code')).rejects.toBeInstanceOf(JiraOAuthError);
  });

  it('throws JiraOAuthError when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(client.exchangeCode('code')).rejects.toBeInstanceOf(JiraOAuthError);
  });
});

describe('refresh (rotation-aware)', () => {
  it('sends the refresh_token grant and returns the ROTATED access+refresh tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh-ROTATED',
        expires_in: 3600,
        scope: 'read:jira-work',
      }),
    );

    const result = await client.refresh('old-refresh-token');

    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh-ROTATED');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-token',
      client_id: 'client-abc',
      client_secret: 'client-secret-xyz',
    });
  });

  it('throws JiraRefreshInvalidGrantError on a 400 invalid_grant response (refresh token itself is dead)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(client.refresh('dead-refresh-token')).rejects.toBeInstanceOf(
      JiraRefreshInvalidGrantError,
    );
  });

  it('throws plain JiraOAuthError (not invalid-grant) on a 400 with a DIFFERENT error code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_request' }, 400));
    await expect(client.refresh('token')).rejects.toBeInstanceOf(JiraOAuthError);
    await expect(client.refresh('token')).rejects.not.toBeInstanceOf(JiraRefreshInvalidGrantError);
  });

  it('throws plain JiraOAuthError (transient, not invalid-grant) on a 5xx during refresh', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(client.refresh('token')).rejects.toBeInstanceOf(JiraOAuthError);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(client.refresh('token')).rejects.not.toBeInstanceOf(JiraRefreshInvalidGrantError);
  });

  it('does NOT mis-fire invalid_grant handling on exchangeCode (only refresh checks for it)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(client.exchangeCode('bad-code')).rejects.toBeInstanceOf(JiraOAuthError);
    await expect(
      (async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
        return client.exchangeCode('bad-code');
      })(),
    ).rejects.not.toBeInstanceOf(JiraRefreshInvalidGrantError);
  });
});

describe('listAccessibleResources', () => {
  it('GETs the accessible-resources endpoint with a bearer token and parses the resource list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'cloud-id-1',
          url: 'https://acme.atlassian.net',
          name: 'Acme',
          scopes: ['read:jira-work'],
        },
      ]),
    );

    const resources = await client.listAccessibleResources('access-token-1');

    expect(resources).toEqual([
      { id: 'cloud-id-1', url: 'https://acme.atlassian.net', name: 'Acme', scopes: ['read:jira-work'] },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.atlassian.test/oauth/token/accessible-resources');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-1');
  });

  it('returns an empty array when Atlassian grants zero sites', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    expect(await client.listAccessibleResources('token')).toEqual([]);
  });

  it('returns multiple entries when Atlassian grants more than one site', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'cloud-1', url: 'https://one.atlassian.net', name: 'One', scopes: [] },
        { id: 'cloud-2', url: 'https://two.atlassian.net', name: 'Two', scopes: [] },
      ]),
    );
    expect(await client.listAccessibleResources('token')).toHaveLength(2);
  });

  it('throws JiraOAuthError on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(client.listAccessibleResources('bad-token')).rejects.toBeInstanceOf(JiraOAuthError);
  });

  it('throws JiraOAuthError when the response is not an array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ not: 'an array' }));
    await expect(client.listAccessibleResources('token')).rejects.toBeInstanceOf(JiraOAuthError);
  });
});

describe('getCurrentUser', () => {
  it('GETs /me with a bearer token and parses the current-user record', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ account_id: 'acc-1', email: 'user@example.com', name: 'A User' }),
    );
    const user = await client.getCurrentUser('access-token-1');
    expect(user).toEqual({ accountId: 'acc-1', email: 'user@example.com', name: 'A User' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.atlassian.test/me');
  });

  it('throws JiraOAuthError on upstream failure (callback must treat this as 502, not a completed connection)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(client.getCurrentUser('token')).rejects.toBeInstanceOf(JiraOAuthError);
  });

  it('throws JiraOAuthError when account_id is missing from the response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'user@example.com' }));
    await expect(client.getCurrentUser('token')).rejects.toBeInstanceOf(JiraOAuthError);
  });
});

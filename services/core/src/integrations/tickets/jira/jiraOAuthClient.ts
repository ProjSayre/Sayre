// Atlassian Jira Cloud OAuth 3LO client (W3-10). Concrete, documented
// endpoints/params only — never invented shapes:
//   - Authorize (browser redirect): `${JIRA_OAUTH_AUTHORIZE_URL}` with
//     audience/client_id/scope/redirect_uri/state/response_type/prompt.
//   - Token exchange + refresh: `POST ${JIRA_OAUTH_TOKEN_URL}` (JSON body).
//     Jira ROTATES the refresh token on every refresh — the caller MUST
//     persist the new one; the old one is invalidated by Atlassian.
//   - Accessible resources: `GET ${JIRA_OAUTH_API_BASE_URL}/oauth/token/accessible-resources`.
//   - Current user: `GET ${JIRA_OAUTH_API_BASE_URL}/me`.
//   - Per-connection API gateway base (used by the sync adapter, NOT this
//     client): `${JIRA_OAUTH_API_BASE_URL}/ex/jira/${cloudId}`.
//
// `fetch` is injectable so tests never hit the network. `client_secret` is the
// App-level `JIRA_OAUTH_CLIENT_SECRET` (shared across all orgs — same posture
// as GitHub's single App, per SECRETS.md), resolved through the W0-07 loader.

import { getConfig, getSecret } from '@sayre/config';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JiraAccessibleResource {
  id: string; // Atlassian cloudId
  url: string; // site URL, e.g. https://<tenant>.atlassian.net
  name: string;
  scopes: string[];
}

export interface JiraTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}

export interface JiraOAuthUser {
  accountId: string;
  email: string | null;
  name: string | null;
}

export class JiraOAuthError extends Error {
  constructor(message = 'Jira OAuth request failed.') {
    super(message);
    this.name = 'JiraOAuthError';
  }
}

/** A 400 `invalid_grant` on refresh — the refresh token itself is expired/revoked at Atlassian. */
export class JiraRefreshInvalidGrantError extends JiraOAuthError {
  constructor() {
    super('Jira refresh token is no longer valid.');
    this.name = 'JiraRefreshInvalidGrantError';
  }
}

export interface JiraOAuthClient {
  buildAuthorizeUrl(input: { state: string }): string;
  exchangeCode(code: string): Promise<JiraTokenSet>;
  refresh(refreshToken: string): Promise<JiraTokenSet>;
  listAccessibleResources(accessToken: string): Promise<JiraAccessibleResource[]>;
  getCurrentUser(accessToken: string): Promise<JiraOAuthUser>;
  /**
   * Issue keys updated at/after `since`, via the per-connection API gateway
   * base (`${JIRA_OAUTH_API_BASE_URL}/ex/jira/${cloudId}` -- the caller
   * resolves this, same base the sync adapter's `request()` uses; this client
   * never reconstructs it). Used by the Jira ticket poll loop, NOT the OAuth
   * dance itself.
   */
  searchRecentIssueKeys(
    accessToken: string,
    apiBaseUrl: string,
    since: Date,
  ): Promise<string[]>;
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseTokenSet(body: unknown): JiraTokenSet {
  const record = isRecord(body) ? (body as TokenResponseBody) : {};
  const accessToken = stringOrNull(record.access_token);
  const refreshToken = stringOrNull(record.refresh_token);
  const scope = stringOrNull(record.scope) ?? '';
  const expiresInSeconds =
    typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
      ? record.expires_in
      : Number(record.expires_in);
  if (
    accessToken === null ||
    refreshToken === null ||
    !Number.isFinite(expiresInSeconds)
  ) {
    throw new JiraOAuthError('Jira token response is malformed.');
  }
  return { accessToken, refreshToken, expiresInSeconds, scope };
}

function parseAccessibleResources(body: unknown): JiraAccessibleResource[] {
  if (!Array.isArray(body)) {
    throw new JiraOAuthError('Jira accessible-resources response is malformed.');
  }
  return body.map((entry) => {
    if (!isRecord(entry)) {
      throw new JiraOAuthError('Jira accessible-resources response is malformed.');
    }
    const id = stringOrNull(entry.id);
    const url = stringOrNull(entry.url);
    const name = stringOrNull(entry.name) ?? '';
    if (id === null || url === null) {
      throw new JiraOAuthError('Jira accessible-resources response is malformed.');
    }
    const scopes = Array.isArray(entry.scopes)
      ? entry.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    return { id, url, name, scopes };
  });
}

/** Jira JQL absolute-date literal: `"yyyy-MM-dd HH:mm"` (UTC — a generous poll window makes the difference from the instance's local time irrelevant). */
function formatJqlDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

function parseSearchIssueKeys(body: unknown): string[] {
  const record = isRecord(body) ? body : null;
  const issues = record !== null && Array.isArray(record.issues) ? record.issues : null;
  if (issues === null) {
    throw new JiraOAuthError('Jira search response is malformed.');
  }
  return issues
    .map((issue) => (isRecord(issue) ? stringOrNull(issue.key) : null))
    .filter((key): key is string => key !== null);
}

function parseCurrentUser(body: unknown): JiraOAuthUser {
  if (!isRecord(body)) {
    throw new JiraOAuthError('Jira /me response is malformed.');
  }
  const accountId = stringOrNull(body.account_id);
  if (accountId === null) {
    throw new JiraOAuthError('Jira /me response is malformed.');
  }
  return {
    accountId,
    email: stringOrNull(body.email),
    name: stringOrNull(body.name),
  };
}

class AtlassianJiraOAuthClient implements JiraOAuthClient {
  constructor(private readonly fetcher: FetchLike) {}

  buildAuthorizeUrl(input: { state: string }): string {
    // Built exactly per spec.md's literal query-string shape (manual
    // interpolation + encodeURIComponent on the free-form values only), NOT
    // URLSearchParams — that would use '+' rather than '%20' for the space in
    // JIRA_OAUTH_SCOPES and would additionally percent-encode `client_id`,
    // which spec.md's concrete shape does not.
    const authorizeUrl = getConfig('JIRA_OAUTH_AUTHORIZE_URL');
    const clientId = getConfig('JIRA_OAUTH_CLIENT_ID');
    const scopes = getConfig('JIRA_OAUTH_SCOPES');
    const callbackUrl = getConfig('JIRA_OAUTH_CALLBACK_URL');
    return (
      `${authorizeUrl}?audience=api.atlassian.com&client_id=${clientId}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
      `&state=${encodeURIComponent(input.state)}` +
      `&response_type=code&prompt=consent`
    );
  }

  private async tokenRequest(
    body: Record<string, string>,
    isRefresh: boolean,
  ): Promise<JiraTokenSet> {
    const tokenUrl = getConfig('JIRA_OAUTH_TOKEN_URL');
    const clientId = getConfig('JIRA_OAUTH_CLIENT_ID');
    const clientSecret = await getSecret('env://JIRA_OAUTH_CLIENT_SECRET');
    let response: Response;
    try {
      response = await this.fetcher(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...body, client_id: clientId, client_secret: clientSecret }),
      });
    } catch {
      throw new JiraOAuthError('Jira token request could not be sent.');
    }
    if (!response.ok) {
      if (isRefresh && response.status === 400) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const error = isRecord(payload) ? stringOrNull(payload.error) : null;
        if (error === 'invalid_grant') throw new JiraRefreshInvalidGrantError();
      }
      throw new JiraOAuthError(`Jira token request returned ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new JiraOAuthError('Jira token response was not valid JSON.');
    }
    return parseTokenSet(payload);
  }

  async exchangeCode(code: string): Promise<JiraTokenSet> {
    const callbackUrl = getConfig('JIRA_OAUTH_CALLBACK_URL');
    return this.tokenRequest(
      { grant_type: 'authorization_code', code, redirect_uri: callbackUrl },
      false,
    );
  }

  async refresh(refreshToken: string): Promise<JiraTokenSet> {
    return this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      true,
    );
  }

  async listAccessibleResources(
    accessToken: string,
  ): Promise<JiraAccessibleResource[]> {
    const apiBaseUrl = getConfig('JIRA_OAUTH_API_BASE_URL');
    let response: Response;
    try {
      response = await this.fetcher(`${apiBaseUrl}/oauth/token/accessible-resources`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
    } catch {
      throw new JiraOAuthError('Jira accessible-resources request could not be sent.');
    }
    if (!response.ok) {
      throw new JiraOAuthError(`Jira accessible-resources request returned ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new JiraOAuthError('Jira accessible-resources response was not valid JSON.');
    }
    return parseAccessibleResources(payload);
  }

  async searchRecentIssueKeys(
    accessToken: string,
    apiBaseUrl: string,
    since: Date,
  ): Promise<string[]> {
    // `GET/POST /rest/api/3/search` is retired (410 Gone, confirmed live) —
    // Atlassian's replacement is `POST /rest/api/3/search/jql`.
    const jql = `updated >= "${formatJqlDate(since)}" order by updated asc`;
    const url = `${apiBaseUrl}/rest/api/3/search/jql`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jql, fields: ['key'], maxResults: 100 }),
      });
    } catch {
      throw new JiraOAuthError('Jira search request could not be sent.');
    }
    if (!response.ok) {
      throw new JiraOAuthError(`Jira search request returned ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new JiraOAuthError('Jira search response was not valid JSON.');
    }
    return parseSearchIssueKeys(payload);
  }

  async getCurrentUser(accessToken: string): Promise<JiraOAuthUser> {
    const apiBaseUrl = getConfig('JIRA_OAUTH_API_BASE_URL');
    let response: Response;
    try {
      response = await this.fetcher(`${apiBaseUrl}/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
    } catch {
      throw new JiraOAuthError('Jira /me request could not be sent.');
    }
    if (!response.ok) {
      throw new JiraOAuthError(`Jira /me request returned ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new JiraOAuthError('Jira /me response was not valid JSON.');
    }
    return parseCurrentUser(payload);
  }
}

export function createDefaultJiraOAuthClient(): JiraOAuthClient {
  return new AtlassianJiraOAuthClient((input, init) => fetch(input, init));
}

// GitHub user-to-server OAuth client: exchanges a one-time authorization
// `code` for an access token, then fetches the authenticated user's identity
// (and, when the primary email is private, falls back to the verified-email
// list). Distinct trust boundary from src/github/appClient.ts (App-to-server,
// installation tokens) — this client speaks for a HUMAN GitHub account during
// login (AUTH-01), not an installation.
//
// Two hosts: the code exchange talks to the OAuth WEB host
// (GITHUB_WEB_BASE_URL, e.g. https://github.com/login/oauth/access_token);
// identity calls talk to the API host (GITHUB_API_BASE_URL), same as
// appClient.ts's githubApiFetch shape.
//
// Behind the `GithubOAuthClient` interface so callers (loginService.ts)
// inject a fake in tests instead of hitting the real GitHub API.
//
// Credential/token discipline (.claude/rules/security-multitenancy.md): the
// access token is IN-MEMORY ONLY — never persisted, never logged. The
// authorization code, the client secret, and any response body are never
// logged either.

import { getConfig, getSecret } from '@sayre/config';

export interface GithubOAuthUser {
  id: string; // GitHub numeric user id, as string (stable identity key)
  login: string; // GitHub login (globally unique on GitHub)
  name: string | null;
  email: string | null; // may be null (private-primary-email accounts)
}

export interface GithubOAuthClient {
  exchangeCodeForToken(code: string): Promise<string>;
  getAuthenticatedUser(accessToken: string): Promise<GithubOAuthUser>;
  getPrimaryVerifiedEmail(accessToken: string): Promise<string>;
}

/** Network / non-2xx / infra failure on any of the three calls. */
export class GithubOAuthApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubOAuthApiError';
  }
}

/** The code exchange returned an error body (bad/expired/reused code). */
export class GithubOAuthCodeError extends Error {
  constructor(message = 'GitHub rejected the authorization code.') {
    super(message);
    this.name = 'GithubOAuthCodeError';
  }
}

/** No usable (primary+verified, or any verified) email on the GitHub account. */
export class NoVerifiedEmailError extends Error {
  constructor(message = 'No usable verified email on the GitHub account.') {
    super(message);
    this.name = 'NoVerifiedEmailError';
  }
}

interface GithubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

interface GithubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * POSTs the code exchange. GitHub returns HTTP 200 even for a bad/reused/
 * expired code, with `{ error: 'bad_verification_code', ... }` in the body —
 * so success requires a present, non-empty `access_token`; anything else
 * (body `error`, or no `access_token`) is a `GithubOAuthCodeError`. Transport
 * failure / non-2xx is a `GithubOAuthApiError`. NEVER logs the code, the
 * client secret, the response body, or the access token.
 */
async function exchangeCodeForToken(code: string): Promise<string> {
  const webBaseUrl = getConfig('GITHUB_WEB_BASE_URL');
  const clientId = getConfig('GITHUB_APP_CLIENT_ID');
  const clientSecret = await getSecret('env://GITHUB_APP_CLIENT_SECRET');

  let response: Response;
  try {
    response = await fetch(`${webBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
  } catch (error) {
    throw new GithubOAuthApiError(
      `GitHub code exchange request failed: ${error instanceof Error ? error.message : 'network error'}`,
    );
  }

  if (!response.ok) {
    throw new GithubOAuthApiError(`GitHub code exchange returned ${response.status}.`);
  }

  let body: GithubAccessTokenResponse;
  try {
    body = (await response.json()) as GithubAccessTokenResponse;
  } catch {
    throw new GithubOAuthApiError('GitHub code exchange returned a non-JSON body.');
  }

  if (!body.access_token) {
    // Covers both an explicit `error` field (e.g. bad_verification_code) and
    // a 200 response missing access_token for any other reason — both are
    // the single-use-code-rejected case from the caller's perspective.
    throw new GithubOAuthCodeError();
  }

  return body.access_token; // in-memory only — caller must not log/persist this.
}

async function githubApiFetch(path: string, accessToken: string): Promise<Response> {
  const apiBaseUrl = getConfig('GITHUB_API_BASE_URL');
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new GithubOAuthApiError(
      `GitHub API request to ${path} failed: ${error instanceof Error ? error.message : 'network error'}`,
    );
  }
  if (!response.ok) {
    throw new GithubOAuthApiError(`GitHub API request to ${path} returned ${response.status}.`);
  }
  return response;
}

/** GET /user. Maps `{ id, login, name, email }`, coercing `id` to `String(id)`. */
async function getAuthenticatedUser(accessToken: string): Promise<GithubOAuthUser> {
  try {
    const response = await githubApiFetch('/user', accessToken);
    const body = (await response.json()) as GithubUserResponse;
    return {
      id: String(body.id),
      login: body.login,
      name: body.name ?? null,
      email: body.email ?? null,
    };
  } catch (error) {
    if (error instanceof GithubOAuthApiError) throw error;
    throw new GithubOAuthApiError(
      `Failed to fetch the authenticated GitHub user: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * GET /user/emails (requires OAuth scope user:email). Picks `primary &&
 * verified`, else the first `verified`, else throws `NoVerifiedEmailError`.
 */
async function getPrimaryVerifiedEmail(accessToken: string): Promise<string> {
  let emails: GithubEmailResponse[];
  try {
    const response = await githubApiFetch('/user/emails', accessToken);
    emails = (await response.json()) as GithubEmailResponse[];
  } catch (error) {
    if (error instanceof GithubOAuthApiError) throw error;
    throw new GithubOAuthApiError(
      `Failed to fetch GitHub account emails: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const primaryVerified = emails.find((entry) => entry.primary && entry.verified);
  if (primaryVerified) return primaryVerified.email;

  const firstVerified = emails.find((entry) => entry.verified);
  if (firstVerified) return firstVerified.email;

  throw new NoVerifiedEmailError();
}

/** Default, real-network implementation. Tests inject a fake `GithubOAuthClient` instead. */
export function createDefaultGithubOAuthClient(): GithubOAuthClient {
  return { exchangeCodeForToken, getAuthenticatedUser, getPrimaryVerifiedEmail };
}

// GitHub App API client: mints a short-lived App JWT, exchanges it for an
// installation access token, and lists the repos an installation has access
// to. Installation credentials (the App private key and the minted
// installation token) are read/used ONLY through the W0-07 secret loader /
// in-memory — NEVER persisted to Postgres, NEVER logged
// (.claude/rules/security-multitenancy.md; SECRETS.md "GitHub installation/
// account IDs and short-lived installation tokens" row).
//
// Behind the `GithubAppClient` interface so callers (githubAppInstallService)
// inject a fake in tests instead of hitting the real GitHub API. Any failure
// here (bad key, 401, network, non-2xx response) is normalized to a single
// `GithubAppApiError` — the caller (githubAppInstallService.ts) maps that to
// its own `GithubApiError` -> 502.

import jwt from 'jsonwebtoken';
import { getConfig, getSecret } from '@sayre/config';

export interface InstalledRepo {
  provider_repo_id: string; // GitHub numeric repo id as string
  full_name: string; // 'owner/name'
  default_branch: string | null; // null for an empty repo with no commits
  default_branch_head_sha: string | null; // null when the repository has no branch HEAD
}

export interface AuthorizedInstallation {
  account_login: string;
  account_type: 'Organization' | 'User';
}

export interface GithubAppClient {
  /**
   * Exchanges the one-time OAuth callback code and proves the authorizing user
   * owns the installation account (personal account) or is an active
   * organization admin. The short-lived user token remains in memory only.
   */
  authorizeInstallation(
    code: string,
    installationId: number,
  ): Promise<AuthorizedInstallation>;
  mintInstallationToken(installationId: number): Promise<string>; // in-memory only, never persisted/logged
  listInstallationRepos(installationId: number, maxRepos?: number): Promise<InstalledRepo[]>; // handles pagination
}

/** Normalized failure for any GitHub App API call (token mint or repo list). */
export class GithubAppApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubAppApiError';
  }
}

/** The OAuth user is valid but cannot administer the installation account. */
export class GithubAppAuthorizationError extends GithubAppApiError {
  constructor() {
    super('The authorizing GitHub user cannot administer this installation account.');
    this.name = 'GithubAppAuthorizationError';
  }
}

const APP_JWT_EXPIRY_SECONDS = 9 * 60; // GitHub allows up to 10m; stay comfortably under.
const PER_PAGE = 100;
const REVISION_SHA = /^[0-9a-fA-F]{40,64}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const REPOSITORY_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_BRANCH_LOOKUP_CONCURRENCY = 5;
const MAX_JSON_RESPONSE_BYTES = 256 * 1024;

interface GithubRepoResponse {
  id: number;
  full_name: string;
  default_branch: string | null;
}

interface GithubRefResponse {
  object?: {
    sha?: unknown;
  };
}

interface GithubInstallationResponse {
  account?: {
    login?: unknown;
    type?: unknown;
  };
}

interface GithubUserResponse {
  login?: unknown;
}

interface GithubMembershipResponse {
  state?: unknown;
  role?: unknown;
}

async function mintAppJwt(): Promise<string> {
  const privateKey = await getSecret('env://GITHUB_APP_PRIVATE_KEY');
  const appId = getConfig('GITHUB_APP_ID');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60, // small clock-drift allowance, mirrors GitHub's own docs
      exp: now + APP_JWT_EXPIRY_SECONDS,
      iss: appId,
    },
    privateKey,
    { algorithm: 'RS256' },
  );
}

async function githubApiFetch(
  path: string,
  init: RequestInit,
  allowedErrorStatuses: readonly number[] = [],
): Promise<Response> {
  const baseUrl = getConfig('GITHUB_API_BASE_URL');
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      redirect: 'manual',
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    });
  } catch (error) {
    throw new GithubAppApiError(
      `GitHub API request to ${path} failed: ${error instanceof Error ? error.message : 'network error'}`,
    );
  }
  if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
    // Never echo response body verbatim — it could carry request-context noise. Status only.
    throw new GithubAppApiError(`GitHub API request to ${path} returned ${response.status}.`);
  }
  return response;
}

async function githubWebFetch(path: string, init: RequestInit): Promise<Response> {
  const baseUrl = getConfig('GITHUB_WEB_BASE_URL');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GithubAppApiError(`GitHub OAuth request to ${path} failed.`);
  }
  if (!response.ok) {
    throw new GithubAppApiError(`GitHub OAuth request to ${path} returned ${response.status}.`);
  }
  return response;
}

async function readBoundedJson<T>(response: Response, context: string): Promise<T> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new GithubAppApiError(`${context} returned an invalid Content-Length.`);
    }
    if (declaredBytes > MAX_JSON_RESPONSE_BYTES) {
      throw new GithubAppApiError(`${context} returned an oversized response.`);
    }
  }

  if (response.body === null) {
    throw new GithubAppApiError(`${context} returned an empty response.`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_JSON_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GithubAppApiError(`${context} returned an oversized response.`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new GithubAppApiError(`${context} returned invalid JSON.`);
  }
}

function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GithubAppApiError('GitHub repository list limit must be a positive integer.');
  }
  return value;
}

function encodedRepositoryPath(fullName: string): string {
  const parts = fullName.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new GithubAppApiError('GitHub returned a malformed repository full_name.');
  }
  return parts.map(encodeURIComponent).join('/');
}

function encodedBranchRef(branch: string): string {
  const parts = branch.split('/');
  if (parts.some((part) => part.length === 0)) {
    throw new GithubAppApiError('GitHub returned a malformed default branch.');
  }
  return ['heads', ...parts].map(encodeURIComponent).join('/');
}

async function resolveDefaultBranchHead(
  token: string,
  repo: GithubRepoResponse,
  signal: AbortSignal,
): Promise<string | null> {
  if (repo.default_branch === null) return null;
  if (repo.default_branch.trim().length === 0) {
    throw new GithubAppApiError('GitHub returned a blank default branch.');
  }

  const response = await githubApiFetch(
    `/repos/${encodedRepositoryPath(repo.full_name)}/git/ref/${encodedBranchRef(repo.default_branch)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
    // GitHub documents 409 for an empty or unavailable Git repository. Such a
    // repository is still registered, but there is no immutable commit to parse.
    [409],
  );
  if (response.status === 409) return null;

  const body = await readBoundedJson<GithubRefResponse>(
    response,
    'GitHub default-branch lookup',
  );
  const sha = body.object?.sha;
  if (typeof sha !== 'string' || !REVISION_SHA.test(sha)) {
    throw new GithubAppApiError('GitHub returned an invalid default-branch HEAD SHA.');
  }
  return sha.toLowerCase();
}

async function authorizeInstallation(
  code: string,
  installationId: number,
): Promise<AuthorizedInstallation> {
  try {
    if (code.trim().length === 0) {
      throw new GithubAppApiError('GitHub OAuth callback code is missing.');
    }

    const appJwt = await mintAppJwt();
    const installationResponse = await githubApiFetch(
      `/app/installations/${installationId}`,
      { headers: { Authorization: `Bearer ${appJwt}` } },
    );
    const installation = await readBoundedJson<GithubInstallationResponse>(
      installationResponse,
      'GitHub installation lookup',
    );
    const accountLogin = installation.account?.login;
    const accountType = installation.account?.type;
    if (
      typeof accountLogin !== 'string' ||
      accountLogin.trim().length === 0 ||
      (accountType !== 'Organization' && accountType !== 'User')
    ) {
      throw new GithubAppApiError('GitHub returned invalid installation account metadata.');
    }

    const clientId = getConfig('GITHUB_APP_CLIENT_ID');
    const clientSecret = await getSecret('env://GITHUB_APP_CLIENT_SECRET');
    const tokenResponse = await githubWebFetch('/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    const tokenBody = await readBoundedJson<{ access_token?: unknown; error?: unknown }>(
      tokenResponse,
      'GitHub OAuth token exchange',
    );
    if (typeof tokenBody.access_token !== 'string' || tokenBody.access_token.length === 0) {
      throw new GithubAppApiError('GitHub did not return a user access token.');
    }
    const userToken = tokenBody.access_token;

    const userResponse = await githubApiFetch('/user', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const user = await readBoundedJson<GithubUserResponse>(
      userResponse,
      'GitHub authenticated-user lookup',
    );
    if (typeof user.login !== 'string' || user.login.trim().length === 0) {
      throw new GithubAppApiError('GitHub returned invalid authenticated-user metadata.');
    }

    if (accountType === 'User') {
      if (user.login.toLowerCase() !== accountLogin.toLowerCase()) {
        throw new GithubAppAuthorizationError();
      }
    } else {
      const membershipResponse = await githubApiFetch(
        `/user/memberships/orgs/${encodeURIComponent(accountLogin)}`,
        { headers: { Authorization: `Bearer ${userToken}` } },
      );
      const membership = await readBoundedJson<GithubMembershipResponse>(
        membershipResponse,
        'GitHub organization-membership lookup',
      );
      if (membership.state !== 'active' || membership.role !== 'admin') {
        throw new GithubAppAuthorizationError();
      }
    }

    return {
      account_login: accountLogin,
      account_type: accountType,
    };
  } catch (error) {
    if (error instanceof GithubAppApiError) throw error;
    throw new GithubAppApiError('Failed to authorize the GitHub App installation.');
  }
}

/** Wraps ANY failure (secret loader, JWT signing, network, non-2xx) as GithubAppApiError. */
async function mintInstallationToken(
  installationId: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const appJwt = await mintAppJwt();
    const response = await githubApiFetch(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appJwt}` },
      signal,
    });
    const body = await readBoundedJson<{ token?: string }>(
      response,
      'GitHub installation-token exchange',
    );
    if (!body.token) {
      throw new GithubAppApiError('GitHub did not return an installation access token.');
    }
    return body.token; // in-memory only — caller must not log/persist this.
  } catch (error) {
    if (error instanceof GithubAppApiError) throw error;
    throw new GithubAppApiError(
      `Failed to mint a GitHub App installation token: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

async function resolveRepositoryPage(
  token: string,
  pageRepos: readonly GithubRepoResponse[],
  signal: AbortSignal,
): Promise<InstalledRepo[]> {
  const results = new Array<InstalledRepo>(pageRepos.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(DEFAULT_BRANCH_LOOKUP_CONCURRENCY, pageRepos.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= pageRepos.length) return;

        const repo = pageRepos[index];
        results[index] = {
          provider_repo_id: String(repo.id),
          full_name: repo.full_name,
          default_branch: repo.default_branch ?? null,
          default_branch_head_sha: await resolveDefaultBranchHead(token, repo, signal),
        };
      }
    },
  );

  await Promise.all(workers);
  return results;
}

async function discoverInstallationRepos(
  installationId: number,
  maxRepos: number | undefined,
  signal: AbortSignal,
): Promise<InstalledRepo[]> {
  const token = await mintInstallationToken(installationId, signal);
  const limit = positiveLimit(maxRepos);
  const repos: InstalledRepo[] = [];
  let page = 1;

  for (;;) {
    const remaining = limit === undefined ? PER_PAGE : Math.min(PER_PAGE, limit - repos.length);
    if (remaining <= 0) break;
    const response = await githubApiFetch(
      `/installation/repositories?per_page=${remaining}&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    );
    const body = await readBoundedJson<{ repositories?: GithubRepoResponse[] }>(
      response,
      'GitHub installation repository list',
    );
    const pageRepos = (body.repositories ?? []).slice(0, remaining);
    repos.push(...(await resolveRepositoryPage(token, pageRepos, signal)));
    if (repos.length === limit || pageRepos.length < remaining) break;
    page += 1;
  }

  return repos;
}

/** Wraps ANY failure (including a failed token mint) as GithubAppApiError. */
async function listInstallationRepos(
  installationId: number,
  maxRepos?: number,
): Promise<InstalledRepo[]> {
  const operationController = new AbortController();
  const deadlineError = new GithubAppApiError(
    'GitHub repository discovery exceeded its overall deadline.',
  );
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineHandle = setTimeout(() => {
      operationController.abort(deadlineError);
      reject(deadlineError);
    }, REPOSITORY_DISCOVERY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      discoverInstallationRepos(installationId, maxRepos, operationController.signal),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof GithubAppApiError) throw error;
    throw new GithubAppApiError(
      `Failed to list GitHub App installation repositories: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  } finally {
    if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
    if (!operationController.signal.aborted) {
      operationController.abort(
        new GithubAppApiError('GitHub repository discovery has completed.'),
      );
    }
  }
}

/** Default, real-network implementation. Tests inject a fake `GithubAppClient` instead. */
export function createDefaultGithubAppClient(): GithubAppClient {
  return { authorizeInstallation, mintInstallationToken, listInstallationRepos };
}

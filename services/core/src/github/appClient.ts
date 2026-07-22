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
}

export interface GithubAppClient {
  mintInstallationToken(installationId: number): Promise<string>; // in-memory only, never persisted/logged
  listInstallationRepos(installationId: number): Promise<InstalledRepo[]>; // handles pagination
}

/** Normalized failure for any GitHub App API call (token mint or repo list). */
export class GithubAppApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubAppApiError';
  }
}

const APP_JWT_EXPIRY_SECONDS = 9 * 60; // GitHub allows up to 10m; stay comfortably under.
const PER_PAGE = 100;

interface GithubRepoResponse {
  id: number;
  full_name: string;
  default_branch: string | null;
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

async function githubApiFetch(path: string, init: RequestInit): Promise<Response> {
  const baseUrl = getConfig('GITHUB_API_BASE_URL');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
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
  if (!response.ok) {
    // Never echo response body verbatim — it could carry request-context noise. Status only.
    throw new GithubAppApiError(`GitHub API request to ${path} returned ${response.status}.`);
  }
  return response;
}

/** Wraps ANY failure (secret loader, JWT signing, network, non-2xx) as GithubAppApiError. */
async function mintInstallationToken(installationId: number): Promise<string> {
  try {
    const appJwt = await mintAppJwt();
    const response = await githubApiFetch(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appJwt}` },
    });
    const body = (await response.json()) as { token?: string };
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

/** Wraps ANY failure (including a failed token mint) as GithubAppApiError. */
async function listInstallationRepos(installationId: number): Promise<InstalledRepo[]> {
  try {
    const token = await mintInstallationToken(installationId);
    const repos: InstalledRepo[] = [];
    let page = 1;

    for (;;) {
      const response = await githubApiFetch(
        `/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const body = (await response.json()) as { repositories?: GithubRepoResponse[] };
      const pageRepos = body.repositories ?? [];
      for (const repo of pageRepos) {
        repos.push({
          provider_repo_id: String(repo.id),
          full_name: repo.full_name,
          default_branch: repo.default_branch ?? null,
        });
      }
      if (pageRepos.length < PER_PAGE) break;
      page += 1;
    }

    return repos;
  } catch (error) {
    if (error instanceof GithubAppApiError) throw error;
    throw new GithubAppApiError(
      `Failed to list GitHub App installation repositories: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/** Default, real-network implementation. Tests inject a fake `GithubAppClient` instead. */
export function createDefaultGithubAppClient(): GithubAppClient {
  return { mintInstallationToken, listInstallationRepos };
}

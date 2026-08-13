import { getConfig } from '@sayre/config';
import { createDefaultGithubAppClient } from '../../../github/appClient';
import { isValidRepoFullName } from '../../../github/repoFullName';
import { readBoundedJson } from '../../../http/boundedJson';
import {
  GIT_PROVIDER_REQUEST_TIMEOUT_MS,
  GITHUB_PUSH_COMMIT_CAP,
  MAX_PULL_REQUEST_FILE_PAGES,
} from '../budgets';
import type {
  GitIdentity,
  GitProviderAdapter,
  GitProviderContext,
  ProviderChangeSet,
  ProviderFileEdit,
  ProviderRepoEvent,
  PullRequestMetadata,
} from '../types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type MintInstallationToken = (installationId: number) => Promise<string>;

export class GithubGitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubGitSyncError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isoOrFallback(value: unknown, fallback: string): string {
  const candidate = stringOrNull(value);
  return candidate !== null && !Number.isNaN(Date.parse(candidate)) ? candidate : fallback;
}

function normalizeBranchRef(value: unknown): string | null {
  const ref = stringOrNull(value);
  if (ref === null) return null;
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

function identity(value: unknown): GitIdentity {
  const author = record(value) ?? {};
  return {
    name: stringOrNull(author.name),
    email: stringOrNull(author.email),
    login: stringOrNull(author.username) ?? stringOrNull(author.login),
  };
}

function filePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((path): path is string => typeof path === 'string' && path.length > 0);
}

/**
 * W3-04 gapfill (GAP-5). `size`/`distinct_size` (added to normalizePush's passthrough,
 * see webhooks/normalizeGithubEvent.ts) report the full commit count GitHub applied to the
 * ref; `commits` is capped at GITHUB_PUSH_COMMIT_CAP entries. When `size` is absent
 * (older/synthetic payloads), a commit count at or above the cap is treated
 * conservatively as truncated, per EC-16.
 */
function resolvePush(event: ProviderRepoEvent, occurredAt: string): ProviderChangeSet {
  const rawCommits = Array.isArray(event.payload.commits) ? event.payload.commits : [];
  const edits: ProviderFileEdit[] = [];
  for (const rawCommit of rawCommits) {
    const commit = record(rawCommit);
    if (commit === null) continue;
    const commitSha = stringOrNull(commit.id);
    if (commitSha === null) continue;
    const author = identity(commit.author);
    const paths = [...filePaths(commit.added), ...filePaths(commit.modified)];
    for (const path of new Set(paths)) {
      edits.push({
        path,
        commitSha,
        commitMessage: stringOrNull(commit.message),
        editedAt: isoOrFallback(commit.timestamp, occurredAt),
        author,
        pullRequest: null,
      });
    }
  }

  const declaredSize = event.payload.size;
  const truncated =
    typeof declaredSize === 'number'
      ? declaredSize > rawCommits.length
      : rawCommits.length >= GITHUB_PUSH_COMMIT_CAP;
  const rebuildRequired = event.payload.forced === true;

  return { refName: normalizeBranchRef(event.ref), edits, truncated, rebuildRequired };
}

function pullRequestMetadata(
  payload: Record<string, unknown>,
  pullRequest: Record<string, unknown>,
  occurredAt: string,
): PullRequestMetadata | null {
  const number = payload.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
  return {
    number,
    title: stringOrNull(pullRequest.title),
    url: stringOrNull(pullRequest.html_url),
    mergedAt: isoOrFallback(pullRequest.merged_at, occurredAt),
  };
}

/** GAP-9: replaces the bare `.split('/').map(encodeURIComponent).join('/')`, which does
 *  not escape `.` and so admits a dot-segment full_name (`a/../../owner/repo`) intact
 *  through to a request that carries a live installation token. Reuses the shared,
 *  already-hardened validator (services/core/src/github/repoFullName.ts, the W1-02
 *  gapfill module) rather than appClient.ts's weaker two-part check, which still admits
 *  '..' segments. The message never echoes the offending value. */
function encodedRepositoryPath(fullName: string): string {
  if (!isValidRepoFullName(fullName)) {
    throw new GithubGitSyncError('GitHub repository full_name is malformed.');
  }
  return fullName.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/** GAP-3: bounded on all three axes — page cap (throws, never silently truncates), a
 *  per-request AbortSignal.timeout, and `redirect: 'manual'` so a 3xx is never followed
 *  with a live installation token. */
async function listPullRequestFiles(
  event: ProviderRepoEvent,
  pullNumber: number,
  token: string,
  fetcher: FetchLike,
): Promise<string[]> {
  const repository = encodedRepositoryPath(event.repo.full_name);
  const files: string[] = [];

  for (let page = 1; page <= MAX_PULL_REQUEST_FILE_PAGES; page += 1) {
    const response = await fetcher(
      `${getConfig('GITHUB_API_BASE_URL')}/repos/${repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(GIT_PROVIDER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new GithubGitSyncError(`GitHub pull-request files request returned ${response.status}.`);
    }
    const body = await readBoundedJson<unknown>(
      response,
      'GitHub pull-request files list',
      (message) => new GithubGitSyncError(message),
    );
    if (!Array.isArray(body)) throw new GithubGitSyncError('GitHub returned an invalid files response.');
    const pageFiles = body
      .map((entry) => stringOrNull(record(entry)?.filename))
      .filter((path): path is string => path !== null);
    files.push(...pageFiles);

    if (body.length < 100) return [...new Set(files)].sort();
    if (page === MAX_PULL_REQUEST_FILE_PAGES) {
      // Reaching the cap must NEVER silently return a truncated list — that would
      // reintroduce GAP-5's exact defect on the PR path. Throw so GAP-4's retry policy
      // (jobPolicy.ts) can retry the whole job instead.
      throw new GithubGitSyncError('GitHub pull-request files pagination exceeded the page cap.');
    }
  }

  // Unreachable: the loop above always returns or throws by MAX_PULL_REQUEST_FILE_PAGES.
  throw new GithubGitSyncError('GitHub pull-request files pagination exceeded the page cap.');
}

export interface GithubProviderAdapterOptions {
  /** W3-04 gapfill (GAP-8): provider-agnostic auth seam from the catalog loader. When
   *  present with a non-null credentialRef, resolveCredential() supplies the bearer
   *  token and installation-token minting is skipped entirely. */
  context?: GitProviderContext;
  mintToken?: MintInstallationToken; // test seam, unchanged semantics
  fetcher?: FetchLike; // test seam, unchanged semantics
}

export class GithubProviderAdapter implements GitProviderAdapter {
  readonly provider = 'github';

  private readonly context?: GitProviderContext;
  private readonly mintToken: MintInstallationToken;
  private readonly fetcher: FetchLike;

  constructor(options: GithubProviderAdapterOptions = {}) {
    this.context = options.context;
    this.mintToken =
      options.mintToken ??
      ((installationId) => createDefaultGithubAppClient().mintInstallationToken(installationId));
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  async resolveChanges(event: ProviderRepoEvent, occurredAt: string): Promise<ProviderChangeSet> {
    if (event.type === 'push') return resolvePush(event, occurredAt);
    if (event.type !== 'pull_request') return { refName: null, edits: [] };

    const pullRequest = record(event.payload.pull_request) ?? {};
    if (event.payload.action !== 'closed' || pullRequest.merged !== true) {
      return { refName: null, edits: [] };
    }
    const metadata = pullRequestMetadata(event.payload, pullRequest, occurredAt);
    if (metadata === null) throw new GithubGitSyncError('Merged pull request has no valid number.');

    let token: string;
    if (this.context !== undefined && this.context.credentialRef !== null) {
      // GAP-8: a config-registered credential ref is authoritative — never fall back to
      // minting an installation token when one is configured.
      token = await this.context.resolveCredential();
    } else {
      const installationId = Number(event.installation_id);
      if (!Number.isSafeInteger(installationId) || installationId < 1) {
        throw new GithubGitSyncError('GitHub installation id is invalid.');
      }
      token = await this.mintToken(installationId);
    }

    const paths = await listPullRequestFiles(event, metadata.number, token, this.fetcher);
    const head = record(pullRequest.head) ?? {};
    const base = record(pullRequest.base) ?? {};
    const author = identity(pullRequest.user);
    const commitSha =
      stringOrNull(pullRequest.merge_commit_sha) ?? stringOrNull(head.sha);
    if (commitSha === null) throw new GithubGitSyncError('Merged pull request has no commit sha.');

    return {
      refName: normalizeBranchRef(base.ref),
      edits: paths.map((path) => ({
        path,
        commitSha,
        commitMessage: metadata.title,
        editedAt: metadata.mergedAt,
        author,
        pullRequest: metadata,
      })),
    };
  }
}

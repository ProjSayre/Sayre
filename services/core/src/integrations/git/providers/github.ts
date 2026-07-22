import { getConfig } from '@sayre/config';
import { createDefaultGithubAppClient } from '../../../github/appClient';
import type {
  GitIdentity,
  GitProviderAdapter,
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

function resolvePush(event: ProviderRepoEvent, occurredAt: string): ProviderChangeSet {
  const commits = Array.isArray(event.payload.commits) ? event.payload.commits : [];
  const edits: ProviderFileEdit[] = [];
  for (const rawCommit of commits) {
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
  return { refName: normalizeBranchRef(event.ref), edits };
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

async function listPullRequestFiles(
  event: ProviderRepoEvent,
  pullNumber: number,
  token: string,
  fetcher: FetchLike,
): Promise<string[]> {
  const repository = event.repo.full_name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const files: string[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetcher(
      `${getConfig('GITHUB_API_BASE_URL')}/repos/${repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new GithubGitSyncError(`GitHub pull-request files request returned ${response.status}.`);
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) throw new GithubGitSyncError('GitHub returned an invalid files response.');
    const pageFiles = body
      .map((entry) => stringOrNull(record(entry)?.filename))
      .filter((path): path is string => path !== null);
    files.push(...pageFiles);
    if (body.length < 100) break;
  }
  return [...new Set(files)].sort();
}

export class GithubProviderAdapter implements GitProviderAdapter {
  readonly provider = 'github';

  constructor(
    private readonly mintToken: MintInstallationToken = (installationId) =>
      createDefaultGithubAppClient().mintInstallationToken(installationId),
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async resolveChanges(event: ProviderRepoEvent, occurredAt: string): Promise<ProviderChangeSet> {
    if (event.type === 'push') return resolvePush(event, occurredAt);
    if (event.type !== 'pull_request') return { refName: null, edits: [] };

    const pullRequest = record(event.payload.pull_request) ?? {};
    if (event.payload.action !== 'closed' || pullRequest.merged !== true) {
      return { refName: null, edits: [] };
    }
    const metadata = pullRequestMetadata(event.payload, pullRequest, occurredAt);
    if (metadata === null) throw new GithubGitSyncError('Merged pull request has no valid number.');
    const installationId = Number(event.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      throw new GithubGitSyncError('GitHub installation id is invalid.');
    }
    const token = await this.mintToken(installationId);
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

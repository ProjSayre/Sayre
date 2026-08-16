// W3-04 gapfill (GAP-7). The real, shipped `fakehub` adapter module — replaces the
// `__fixtures__/fakehubProvider.ts` stand-in that discarded both `resolveChanges`
// arguments (`void event; void occurredAt;`) and simply echoed back whatever
// ProviderChangeSet its constructor was handed. This adapter genuinely normalizes a
// fakehub-shaped payload the way GithubProviderAdapter normalizes a GitHub one, so a
// config-registered mock provider can prove the full configuration -> worker -> graph
// path end to end (see __tests__/w3-04.acceptance.integration.test.ts).
//
// Payload shapes (spec.md's Approach step 9):
//   pull_request: { action: 'merged', pull_request: { number, title, url, merged_at,
//     merge_commit_sha, base_ref, author: { login, name, email }, files: string[] } }
//   push: { ref, commits: [{ sha, message, timestamp, author, paths: string[] }] }

import type {
  GitIdentity,
  GitProviderAdapter,
  ProviderChangeSet,
  ProviderFileEdit,
  ProviderRepoEvent,
  PullRequestMetadata,
} from '../types';

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
    login: stringOrNull(author.login),
  };
}

function filePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((path): path is string => typeof path === 'string' && path.length > 0);
}

function resolvePush(payload: Record<string, unknown>, occurredAt: string): ProviderChangeSet {
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const edits: ProviderFileEdit[] = [];
  for (const rawCommit of commits) {
    const commit = record(rawCommit);
    if (commit === null) continue;
    const commitSha = stringOrNull(commit.sha);
    if (commitSha === null) continue; // EC-21: degrade (drop), never invent a commit identity.
    const author = identity(commit.author);
    const editedAt = isoOrFallback(commit.timestamp, occurredAt);
    for (const path of new Set(filePaths(commit.paths))) {
      edits.push({
        path,
        commitSha,
        commitMessage: stringOrNull(commit.message),
        editedAt,
        author,
        pullRequest: null,
      });
    }
  }
  return { refName: normalizeBranchRef(payload.ref), edits };
}

function resolveMergedPullRequest(
  payload: Record<string, unknown>,
  occurredAt: string,
): ProviderChangeSet {
  if (payload.action !== 'merged') return { refName: null, edits: [] };

  const pullRequest = record(payload.pull_request) ?? {};
  const number = pullRequest.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return { refName: null, edits: [] };
  }

  const mergedAt = isoOrFallback(pullRequest.merged_at, occurredAt);
  const metadata: PullRequestMetadata = {
    number,
    title: stringOrNull(pullRequest.title),
    url: stringOrNull(pullRequest.url),
    mergedAt,
  };
  const author = identity(pullRequest.author);
  // EC-21: a missing/unparseable commit sha degrades rather than inventing one — a mock
  // provider must not crash the worker on malformed test data.
  const commitSha = stringOrNull(pullRequest.merge_commit_sha) ?? 'unknown';

  const edits: ProviderFileEdit[] = filePaths(pullRequest.files).map((path) => ({
    path,
    commitSha,
    commitMessage: stringOrNull(pullRequest.title),
    editedAt: mergedAt,
    author,
    pullRequest: metadata,
  }));

  return { refName: normalizeBranchRef(pullRequest.base_ref), edits };
}

export class FakeHubProviderAdapter implements GitProviderAdapter {
  readonly provider = 'fakehub';

  async resolveChanges(event: ProviderRepoEvent, occurredAt: string): Promise<ProviderChangeSet> {
    const payload = record(event.payload) ?? {};
    if (event.type === 'push') return resolvePush(payload, occurredAt);
    if (event.type === 'pull_request') return resolveMergedPullRequest(payload, occurredAt);
    return { refName: null, edits: [] };
  }
}

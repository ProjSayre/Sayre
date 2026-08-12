// Pure GitHub webhook event normalizer: X-GitHub-Event + already-JSON-parsed,
// already-signature-validated body -> provider-generic NormalizedRepoEvent.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): this module
// NEVER reads org_id/organization/owner from `parsed` — org_id is resolved server-side
// from the installation id by the caller (services/githubWebhookService.ts), never from
// webhook body input.

import type { NormalizedRepoEvent, RepoEventType } from '@sayre/shared-types';
import { isValidRepoFullName } from '../github/repoFullName';

export type IgnoreReason =
  | 'ping'
  | 'unsupported_event'
  | 'unsupported_ref_type'
  | 'no_installation'
  | 'no_ref';

export interface NormalizationResult {
  event: NormalizedRepoEvent;
  destinations: Array<'ingestion' | 'ownership'>;
}

interface NormalizeInput {
  githubEvent: string;
  deliveryId: string;
  parsed: Record<string, unknown>;
}

/**
 * Thrown when the payload has passed signature validation and JSON parsing but is
 * structurally missing fields (e.g. `repository.id`/`repository.full_name`) that
 * every supported event type requires. Caller (githubWebhookService) maps this to
 * `WebhookBadRequestError` -> 400 (a malformed body, not a routine "nothing to do").
 */
export class MalformedGithubPayloadError extends Error {
  constructor(message = 'GitHub webhook payload is missing required repository fields.') {
    super(message);
    this.name = 'MalformedGithubPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractInstallationId(parsed: Record<string, unknown>): number | null {
  const installation = parsed.installation;
  if (!isRecord(installation)) return null;
  const id = installation.id;
  // GAP-6: a plain `typeof === 'number'` (or the former `Number.isFinite`) admits
  // NaN/Infinity/negative/non-integer values, which downstream code (resolveOrg,
  // the DB lookup) treats as "not a valid installation" only by accident. Require a
  // positive safe integer explicitly so a malformed id is always a clean
  // `no_installation` ignore, never a 500.
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function extractRepo(parsed: Record<string, unknown>): NormalizedRepoEvent['repo'] {
  const repository = parsed.repository;
  if (!isRecord(repository)) throw new MalformedGithubPayloadError();

  const id = repository.id;
  const fullName = repository.full_name;
  if (typeof id !== 'number' && typeof id !== 'string') throw new MalformedGithubPayloadError();
  // GAP-7: full_name must be a real two-segment `owner/name`, not merely non-empty —
  // an unauthenticated webhook body is otherwise free to smuggle a value like
  // '../../evil' into whatever later constructs a path/URL from it.
  if (!isValidRepoFullName(fullName)) throw new MalformedGithubPayloadError();

  return {
    provider_repo_id: String(id),
    full_name: fullName,
    repo_id: null,
  };
}

function normalizePush(parsed: Record<string, unknown>): NormalizedRepoEvent['payload'] {
  const rawCommits = Array.isArray(parsed.commits) ? parsed.commits : [];
  const commits = rawCommits.filter(isRecord).map((commit) => {
    const author = isRecord(commit.author) ? commit.author : {};
    return {
      id: commit.id ?? null,
      message: commit.message ?? null,
      timestamp: commit.timestamp ?? null,
      author: {
        name: author.name ?? null,
        email: author.email ?? null,
        username: author.username ?? null,
      },
      added: commit.added ?? [],
      modified: commit.modified ?? [],
      removed: commit.removed ?? [],
    };
  });

  return {
    before: parsed.before ?? null,
    after: parsed.after ?? null,
    forced: parsed.forced ?? false,
    deleted: parsed.deleted ?? false,
    ref: parsed.ref ?? null,
    commits,
    pusher: parsed.pusher ?? null,
  };
}

function normalizePullRequest(
  parsed: Record<string, unknown>,
): { ref: string | null; payload: NormalizedRepoEvent['payload'] } {
  const pullRequest = isRecord(parsed.pull_request) ? parsed.pull_request : {};
  const head = isRecord(pullRequest.head) ? pullRequest.head : {};
  const base = isRecord(pullRequest.base) ? pullRequest.base : {};
  const user = isRecord(pullRequest.user) ? pullRequest.user : {};

  return {
    ref: nonEmptyString(head.ref),
    payload: {
      action: parsed.action ?? null,
      number: parsed.number ?? null,
      pull_request: {
        id: pullRequest.id ?? null,
        state: pullRequest.state ?? null,
        merged: pullRequest.merged ?? null,
        merged_at: pullRequest.merged_at ?? null,
        merge_commit_sha: pullRequest.merge_commit_sha ?? null,
        title: pullRequest.title ?? null,
        html_url: pullRequest.html_url ?? null,
        head: { ref: head.ref ?? null, sha: head.sha ?? null },
        base: { ref: base.ref ?? null, sha: base.sha ?? null },
        user: { login: user.login ?? null, id: user.id ?? null },
      },
    },
  };
}

function normalizeBranch(
  githubEvent: 'create' | 'delete',
  parsed: Record<string, unknown>,
): NormalizedRepoEvent['payload'] {
  return {
    action: githubEvent === 'create' ? 'created' : 'deleted',
    ref: parsed.ref,
    ref_type: 'branch',
  };
}

/**
 * Pure. `githubEvent` is the X-GitHub-Event header; `parsed` is the already-JSON-parsed,
 * already-signature-validated body. Never reads org_id from `parsed`.
 *
 * Throws `MalformedGithubPayloadError` if the event is one this receiver otherwise
 * accepts but `repository.id`/`repository.full_name` are missing — the caller maps
 * that to a 400, distinct from the 2xx "nothing to do" ignore reasons below.
 */
export function normalizeGithubEvent(
  input: NormalizeInput,
): NormalizationResult | { ignored: IgnoreReason } {
  const { githubEvent, deliveryId, parsed } = input;

  // `ping` is a meta-event GitHub sends on webhook registration; classify it before
  // the installation check so a ping delivery is always reported as `ping` (not
  // `no_installation`) even if a caller sends a minimal ping fixture.
  if (githubEvent === 'ping') {
    return { ignored: 'ping' };
  }

  const installationId = extractInstallationId(parsed);
  if (installationId === null) {
    return { ignored: 'no_installation' };
  }

  let type: RepoEventType;
  let ref: string | null;
  let payload: NormalizedRepoEvent['payload'];
  let destinations: Array<'ingestion' | 'ownership'>;

  switch (githubEvent) {
    case 'push': {
      const pushRef = nonEmptyString(parsed.ref);
      if (!pushRef) return { ignored: 'no_ref' };
      // GAP-5: constrain push, like create/delete already are, to real branch refs.
      // A tag push (refs/tags/*), a PR ref, or a bare branch name (no refs/heads/
      // prefix) is otherwise normalized and published as if it were a branch update.
      if (!pushRef.startsWith('refs/heads/') || pushRef.length <= 'refs/heads/'.length) {
        return { ignored: 'unsupported_ref_type' };
      }
      type = 'push';
      ref = pushRef;
      payload = normalizePush(parsed);
      destinations = ['ingestion', 'ownership'];
      break;
    }

    case 'pull_request': {
      type = 'pull_request';
      const normalized = normalizePullRequest(parsed);
      ref = normalized.ref;
      payload = normalized.payload;
      destinations = ['ownership'];
      break;
    }

    case 'create':
    case 'delete': {
      if (parsed.ref_type !== 'branch') {
        return { ignored: 'unsupported_ref_type' };
      }
      const branchName = nonEmptyString(parsed.ref);
      if (!branchName) return { ignored: 'no_ref' };
      type = 'branch';
      ref = `refs/heads/${branchName}`;
      payload = normalizeBranch(githubEvent, parsed);
      // GAP-8: a branch create/delete carries no revision SHA — there is nothing for the
      // ingestion worker to fetch or parse, and `repo.branch` has no handler on the Python
      // fleet. Routing it to the FIFO ingestion queue produced a permanently-failing
      // delivery that head-of-line blocked every later delta for the same
      // (org, repo, ref) group. Real content always arrives as a separate `push`.
      destinations = ['ownership'];
      break;
    }

    default:
      return { ignored: 'unsupported_event' };
  }

  const repo = extractRepo(parsed);

  const event: NormalizedRepoEvent = {
    provider: 'github',
    type,
    repo,
    ref,
    installation_id: String(installationId),
    delivery_id: deliveryId,
    payload,
  };

  return { event, destinations };
}

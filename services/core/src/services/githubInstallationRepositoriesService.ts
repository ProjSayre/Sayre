// Orchestration for the GitHub `installation_repositories` webhook `added`/`removed` path
// (W2-09). Business logic lives here per .claude/rules/service-layer.md; the caller is
// `githubWebhookService.ts`'s `installation_repositories` branch, which has already
// validated the HMAC signature and parsed the body (via `parseInstallationRepositoriesEvent`)
// before this ever runs.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): org_id is resolved
// ONLY via the privileged pre-tenant `resolveInstallationOrg` lookup (installation id -> org,
// same boundary `githubInstallationLifecycleService.ts` uses), then every mutation runs
// inside `withOrgContext` so RLS scopes the write to that org. Never accepts org_id from the
// webhook body — the input type (`InstallationRepositoriesEvent`) never carries one.
//
// Credential invariant: installation tokens are minted ONLY via the existing `GithubAppClient`
// (W0-07 loader boundary) — no new secret, no new credential store, never logged/persisted.

import type { RepoInitialParseEvent } from '@sayre/shared-types';
import type { InstallationRepositoriesEvent } from '../webhooks/parseInstallationRepositoriesEvent';
import { createDefaultGithubAppClient, type GithubAppClient, type InstalledRepo } from '../github/appClient';
import { getRuntimeDb, resolveInstallationOrg } from '../db/installations';
import { withOrgContext, type Db } from '../db/client';
import { registerRepository, markRepositoryRevoked } from '../db/githubAppInstallWrites';
import { enqueueInitialParseOutbox } from '../db/githubInitialParseOutbox';
import { buildInitialParseEnvelope } from './githubAppInstallService';
import type { MessageEnvelope } from '../queue/envelope';
import { kickInitialParseOutboxDispatcher } from './initialParseOutboxWake';

export type InstallationRepositoriesResult =
  | { status: 'added'; registered: number; enqueued: number }
  | { status: 'removed'; revoked: number }
  | { status: 'ignored'; reason: 'unknown_installation' | 'inactive_installation' };

export interface InstallationRepositoriesDeps {
  resolveOrg: (installationId: number) => Promise<{ orgId: string; active: boolean } | null>;
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  githubClient: GithubAppClient; // getInstallationRepo (added path only)
  registerRepository: typeof registerRepository;
  markRepositoryRevoked: typeof markRepositoryRevoked;
  enqueueInitialParse: (tx: Db, envelope: MessageEnvelope<RepoInitialParseEvent>) => Promise<void>;
  kickInitialParseOutbox: () => void;
}

const defaultDeps: InstallationRepositoriesDeps = {
  resolveOrg: async (installationId) => resolveInstallationOrg(await getRuntimeDb(), installationId),
  withOrg: async (orgId, fn) => withOrgContext(await getRuntimeDb(), orgId, fn),
  githubClient: createDefaultGithubAppClient(),
  registerRepository,
  markRepositoryRevoked,
  enqueueInitialParse: enqueueInitialParseOutbox,
  kickInitialParseOutbox: kickInitialParseOutboxDispatcher,
};

async function applyAdded(
  deps: InstallationRepositoriesDeps,
  orgId: string,
  installationId: number,
  added: InstallationRepositoriesEvent['added'],
): Promise<InstallationRepositoriesResult> {
  // Network calls run OUTSIDE any DB transaction — never hold a tx open across a
  // network round-trip. A malformed full_name (encodedRepositoryPath) or any other
  // GitHub API failure throws here, before any write, so the whole delivery fails
  // (5xx) and GitHub retries the full delivery rather than a partial commit.
  const resolved: InstalledRepo[] = [];
  for (const repo of added) {
    const installedRepo = await deps.githubClient.getInstallationRepo(installationId, repo.fullName);
    // 404: repo access already revoked between webhook send and this fetch running.
    // Skip silently — no error, no write, no enqueue for it.
    if (installedRepo === null) continue;
    resolved.push(installedRepo);
  }

  const { registered, enqueued } = await deps.withOrg(orgId, async (tx) => {
    let registeredCount = 0;
    let enqueuedCount = 0;
    for (const repo of resolved) {
      const { repoId } = await deps.registerRepository(tx, {
        orgId,
        providerRepoId: repo.provider_repo_id,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
      });
      registeredCount += 1;

      // No default branch HEAD (empty/unavailable Git repository) => no immutable
      // revision to parse. Registered, but excluded from the enqueued count —
      // identical to the fresh-install callback's empty-repo handling.
      if (!repo.default_branch || !repo.default_branch_head_sha) continue;

      const envelope = buildInitialParseEnvelope({
        orgId,
        installationId,
        repoId,
        providerRepoId: repo.provider_repo_id,
        fullName: repo.full_name,
        ref: `refs/heads/${repo.default_branch}`,
        revisionSha: repo.default_branch_head_sha,
      });
      await deps.enqueueInitialParse(tx, envelope);
      enqueuedCount += 1;
    }
    return { registered: registeredCount, enqueued: enqueuedCount };
  });

  // Latency optimization only — the durable dispatcher polls independently, so a
  // process/request failure here cannot strand rows (same guarantee as W1-06).
  if (enqueued > 0) deps.kickInitialParseOutbox();

  return { status: 'added', registered, enqueued };
}

async function applyRemoved(
  deps: InstallationRepositoriesDeps,
  orgId: string,
  removed: InstallationRepositoriesEvent['removed'],
): Promise<InstallationRepositoriesResult> {
  const revoked = await deps.withOrg(orgId, async (tx) => {
    let count = 0;
    for (const repo of removed) {
      const applied = await deps.markRepositoryRevoked(tx, {
        orgId,
        providerRepoId: repo.providerRepoId,
      });
      if (applied) count += 1;
    }
    return count;
  });

  return { status: 'removed', revoked };
}

/**
 * Input is the already-parsed, org-free event (`parseInstallationRepositoriesEvent`'s output).
 * Resolves org via the privileged `resolveOrg` (installation id -> org), never from the body.
 *
 * `added`: an inactive (suspended/revoked) installation is ignored — never ingest into a
 * suspended/revoked installation. `removed`: runs regardless of installation `active`, since
 * revoke is safe/idempotent (mirrors W1-06's own uninstall-revocation semantics).
 */
export async function applyInstallationRepositoriesEvent(
  input: InstallationRepositoriesEvent,
  deps: Partial<InstallationRepositoriesDeps> = {},
): Promise<InstallationRepositoriesResult> {
  const resolvedDeps: InstallationRepositoriesDeps = { ...defaultDeps, ...deps };

  const resolved = await resolvedDeps.resolveOrg(input.installationId);
  if (!resolved) {
    return { status: 'ignored', reason: 'unknown_installation' };
  }

  if (input.action === 'added') {
    if (!resolved.active) {
      return { status: 'ignored', reason: 'inactive_installation' };
    }
    return applyAdded(resolvedDeps, resolved.orgId, input.installationId, input.added);
  }

  return applyRemoved(resolvedDeps, resolved.orgId, input.removed);
}

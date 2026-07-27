// Orchestration for the manual "Refresh installations" reconciliation endpoint (W2-09).
// Business logic lives here per .claude/rules/service-layer.md; the caller
// (routes/githubInstallationReconcile.ts) is a thin HTTP adapter that only calls
// `reconcileInstallationRepositories`.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): `orgId` comes ONLY
// from `ctx.orgId` — the server-resolved session `AuthContext` the route attaches via
// authenticate()/requireAuthContext() — NEVER from a query param or request body. Every
// read/write below runs against that single resolved org, scoped by `withOrgContext` (RLS).
//
// OQ-5 (human-confirmed decision, additive-only for MVP): this service repairs ONLY the
// "GitHub reports a repo we don't have" direction (missing, or present-but-revoked in our
// records). It deliberately does NOT implement the destructive "GitHub no longer reports a
// repo we hold as active -> revoke it" direction spec.md's Approach step 8 proposed —
// inferring revocation from a GitHub-API diff (rather than from a real, direct GitHub signal)
// was judged too risky to ship for MVP. `ReconcileDeps` below has no `markRepositoryRevoked`
// dependency and this file contains no call to it, anywhere. The ONLY code path that revokes a
// repository is the real `installation_repositories` "removed" webhook
// (`githubInstallationRepositoriesService.ts`'s `applyRemoved`). If a "removed" webhook is
// ever missed, that repo simply stays un-revoked until a future real removal event — an
// accepted, documented MVP limitation, not something this endpoint routes around.
//
// Credential invariant: installation tokens are minted ONLY via the existing `GithubAppClient`
// (W0-07 loader boundary) — no new secret, no new credential store, never logged/persisted.

import type { RepoInitialParseEvent } from '@sayre/shared-types';
import type { AuthContext } from '../auth/context';
import {
  createDefaultGithubAppClient,
  type GithubAppClient,
  type InstalledRepo,
} from '../github/appClient';
import { getRuntimeDb } from '../db/installations';
import { withOrgContext, type Db } from '../db/client';
import {
  listActiveInstallationsForOrg,
  listOrgGithubRepositories,
  registerRepository,
} from '../db/githubAppInstallWrites';
import { enqueueInitialParseOutbox } from '../db/githubInitialParseOutbox';
import { buildInitialParseEnvelope } from './githubAppInstallService';
import type { MessageEnvelope } from '../queue/envelope';
import { kickInitialParseOutboxDispatcher } from './initialParseOutboxWake';

export interface ReconcileResult {
  installations: number; // active installations examined for this org
  registered: number; // repos inserted/re-activated (missing-in-ours repair)
  enqueued: number; // repo.initial_parse jobs enqueued
  // OQ-5: additive-only for MVP — always 0. Kept in the result shape (rather than removed)
  // so a future ticket that revisits the destructive direction is an additive change to this
  // field's meaning, not a wire-shape break. See the file header for the full rationale.
  revoked: number;
  // true iff any examined installation's GitHub-accessible repo list hit MAX_RECONCILE_REPOS —
  // informational only (that installation may have more repos than reconcile inspected).
  truncated: boolean;
}

export interface ReconcileDeps {
  resolveActiveInstallations: (orgId: string) => Promise<Array<{ installationId: number }>>;
  listOurRepos: (
    orgId: string,
  ) => Promise<Array<{ id: string; externalId: string; revokedAt: Date | null }>>;
  githubClient: GithubAppClient; // listInstallationRepos(installationId, MAX_RECONCILE_REPOS)
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  registerRepository: typeof registerRepository;
  enqueueInitialParse: (tx: Db, envelope: MessageEnvelope<RepoInitialParseEvent>) => Promise<void>;
  kickInitialParseOutbox: () => void;
}

// OQ-3 (human-confirmed): reuses W1-06's MAX_REPOS_PER_CALLBACK value. Keeps the destructive
// direction (were it ever revisited) safe against a merely-truncated GitHub list, and bounds
// this synchronous, request-latency-sensitive admin action the same way the install callback
// bounds itself. Lifting this bound generally is a separate, still-deferred backlog item.
const MAX_RECONCILE_REPOS = 25;

const defaultDeps: ReconcileDeps = {
  resolveActiveInstallations: async (orgId) =>
    withOrgContext(await getRuntimeDb(), orgId, (tx) => listActiveInstallationsForOrg(tx, orgId)),
  listOurRepos: async (orgId) =>
    withOrgContext(await getRuntimeDb(), orgId, (tx) => listOrgGithubRepositories(tx, orgId)),
  githubClient: createDefaultGithubAppClient(),
  withOrg: async (orgId, fn) => withOrgContext(await getRuntimeDb(), orgId, fn),
  registerRepository,
  enqueueInitialParse: enqueueInitialParseOutbox,
  kickInitialParseOutbox: kickInitialParseOutboxDispatcher,
};

/**
 * `ctx.orgId` comes ONLY from the server-resolved session (`AuthContext`) — never from
 * query/body. Reads all active installations for the org, lists each installation's
 * GitHub-accessible repos (network, bounded, no tx), then registers + enqueues any repo
 * GitHub reports that we don't hold active — all writes for the call run inside ONE
 * `withOrgContext(ctx.orgId)` transaction. Never revokes (OQ-5, see file header).
 *
 * A `listInstallationRepos` failure for any one installation fails the WHOLE call (5xx,
 * safe to retry) before any write — no partial "some installations reconciled" state.
 */
export async function reconcileInstallationRepositories(
  ctx: AuthContext,
  deps: Partial<ReconcileDeps> = {},
): Promise<ReconcileResult> {
  const resolvedDeps: ReconcileDeps = { ...defaultDeps, ...deps };
  const orgId = ctx.orgId;

  const installations = await resolvedDeps.resolveActiveInstallations(orgId);
  if (installations.length === 0) {
    return { installations: 0, registered: 0, enqueued: 0, revoked: 0, truncated: false };
  }

  const ourRepos = await resolvedDeps.listOurRepos(orgId);
  const activeExternalIds = new Set(
    ourRepos.filter((repo) => repo.revokedAt === null).map((repo) => repo.externalId),
  );

  // Candidates for additive repair: GitHub repos absent from our active set (missing
  // entirely, or present-but-revoked). Deduped by provider_repo_id in case more than one
  // installation reports the same repo (not expected, but harmless to dedupe) — the
  // reporting installation id is tracked alongside the repo for envelope construction.
  const candidates = new Map<string, { repo: InstalledRepo; installationId: number }>();
  let truncated = false;
  for (const installation of installations) {
    const githubRepos = await resolvedDeps.githubClient.listInstallationRepos(
      installation.installationId,
      MAX_RECONCILE_REPOS,
    );
    if (githubRepos.length >= MAX_RECONCILE_REPOS) truncated = true;
    for (const repo of githubRepos) {
      if (activeExternalIds.has(repo.provider_repo_id)) continue;
      candidates.set(repo.provider_repo_id, { repo, installationId: installation.installationId });
    }
  }

  const { registered, enqueued } = await resolvedDeps.withOrg(orgId, async (tx) => {
    let registeredCount = 0;
    let enqueuedCount = 0;
    for (const { repo, installationId } of candidates.values()) {
      const { repoId } = await resolvedDeps.registerRepository(tx, {
        orgId,
        providerRepoId: repo.provider_repo_id,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
      });
      registeredCount += 1;

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
      await resolvedDeps.enqueueInitialParse(tx, envelope);
      enqueuedCount += 1;
    }
    return { registered: registeredCount, enqueued: enqueuedCount };
  });

  if (enqueued > 0) resolvedDeps.kickInitialParseOutbox();

  return { installations: installations.length, registered, enqueued, revoked: 0, truncated };
}

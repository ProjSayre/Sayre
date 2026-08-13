// Tenant-scoped writers for the GitHub App install flow (W1-06). Every export
// here takes a `tx: Db` that the CALLER has already produced via
// `withOrgContext(db, orgId, fn)` (services/core/src/db/client.ts) — none of
// these functions open their own transaction or set `app.org_id` themselves.
//
// Deliberately kept separate from `db/installations.ts`: that module's
// `resolveInstallationOrg` is the narrow, PRE-tenant-context function call
// (migration 0011's column-limited SECURITY DEFINER boundary) — a fundamentally
// different trust boundary from these tenant-scoped writes, which only ever run
// once `app.org_id` is already set for the current transaction.
//
// No schema migration required: `github_app_installations` and `repositories`
// already exist with every column this ticket needs (see spec.md).

import { and, eq, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { githubAppInstallations, repositories } from './schema';

/**
 * Upsert on `installation_id` (globally unique). Re-installing the same
 * installation id ALWAYS clears any prior `suspended_at`/`revoked_at` — the
 * caller has already confirmed (via `resolveInstallationOrg`, BEFORE
 * `withOrgContext`) that this installation id belongs to this same org, so
 * this is never a cross-org move (see `InstallationOrgConflictError` in
 * `githubAppInstallService.ts`).
 */
export async function upsertInstallation(
  tx: Db,
  row: {
    orgId: string;
    installationId: number;
    accountLogin: string | null;
    accountType: string | null;
    repositorySelection: string | null;
  },
): Promise<void> {
  await tx
    .insert(githubAppInstallations)
    .values({
      orgId: row.orgId,
      installationId: row.installationId,
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      repositorySelection: row.repositorySelection,
      suspendedAt: null,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: githubAppInstallations.installationId,
      set: {
        accountLogin: row.accountLogin,
        accountType: row.accountType,
        repositorySelection: row.repositorySelection,
        suspendedAt: null,
        revokedAt: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Upsert on (org_id, provider='github', external_id=providerRepoId) — the existing composite
 * unique index. W2-09: re-adding a previously-removed repo (installation_repositories `added`
 * webhook, or reconcile's additive repair) clears `revoked_at` — re-activation, consistent with
 * `upsertInstallation` clearing `suspendedAt`/`revokedAt` on re-install.
 *
 * W7-01 (OQ-4): `discoveryRunId`, when supplied, stamps the sweep markers
 * (`last_discovery_run_id`/`last_discovery_at`) — set ONLY by discovery. The webhook `added`
 * path (which never passes it) leaves the marker untouched rather than clearing it, matching
 * `listRevokeSweepCandidates`'s exclusion of rows carrying a currently-observed run's marker.
 */
export async function registerRepository(
  tx: Db,
  row: {
    orgId: string;
    providerRepoId: string;
    fullName: string;
    defaultBranch: string | null;
    discoveryRunId?: string;
  },
): Promise<{ repoId: string }> {
  const now = new Date();
  const discoveryMarker = row.discoveryRunId
    ? { lastDiscoveryRunId: row.discoveryRunId, lastDiscoveryAt: now }
    : {};

  const [inserted] = await tx
    .insert(repositories)
    .values({
      orgId: row.orgId,
      name: row.fullName,
      provider: 'github',
      externalId: row.providerRepoId,
      defaultBranch: row.defaultBranch,
      ...discoveryMarker,
    })
    .onConflictDoUpdate({
      target: [repositories.orgId, repositories.provider, repositories.externalId],
      set: {
        name: row.fullName,
        defaultBranch: row.defaultBranch,
        revokedAt: null,
        updatedAt: now,
        ...discoveryMarker,
      },
    })
    .returning({ id: repositories.id });

  return { repoId: inserted.id };
}

/**
 * OQ-4: active GitHub repositories of this org that the observed runs did NOT report.
 * `observedRunIds` = the completed_run_id of every active installation of the org.
 * `runStartedAt` excludes any row created/updated after the run began (mid-run `added`
 * webhook, or a concurrent installation's run) — the second false-positive guard (EC-34).
 * Only `revoked_at IS NULL` rows ever qualify (EC-36).
 */
export async function listRevokeSweepCandidates(
  tx: Db,
  input: { orgId: string; observedRunIds: string[]; runStartedAt: Date },
): Promise<Array<{ id: string; externalId: string }>> {
  const notObservedByAnyCurrentRun =
    input.observedRunIds.length > 0
      ? or(
          isNull(repositories.lastDiscoveryRunId),
          notInArray(repositories.lastDiscoveryRunId, input.observedRunIds),
        )
      : undefined;

  const rows = await tx
    .select({ id: repositories.id, externalId: repositories.externalId })
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, input.orgId),
        eq(repositories.provider, 'github'),
        isNull(repositories.revokedAt),
        lt(repositories.updatedAt, input.runStartedAt),
        ...(notObservedByAnyCurrentRun ? [notObservedByAnyCurrentRun] : []),
      ),
    );

  return rows
    .filter((row): row is { id: string; externalId: string } => row.externalId !== null)
    .map((row) => ({ id: row.id, externalId: row.externalId }));
}

export async function countActiveGithubRepositories(tx: Db, orgId: string): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(
      and(
        eq(repositories.orgId, orgId),
        eq(repositories.provider, 'github'),
        isNull(repositories.revokedAt),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/**
 * W2-09: mirrors `markInstallationRevoked`'s COALESCE pattern — a redelivered
 * `installation_repositories` `removed` event (or a repeated reconcile pass) for an
 * already-revoked repo is a true no-op; `revoked_at` never advances on retry.
 * Returns true iff a matching (org_id, provider='github', external_id) row was updated.
 */
export async function markRepositoryRevoked(
  tx: Db,
  row: { orgId: string; providerRepoId: string },
): Promise<boolean> {
  const updated = await tx
    .update(repositories)
    .set({
      revokedAt: sql`coalesce(${repositories.revokedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositories.orgId, row.orgId),
        eq(repositories.provider, 'github'),
        eq(repositories.externalId, row.providerRepoId),
      ),
    )
    .returning({ id: repositories.id });
  return updated.length > 0;
}

/**
 * W2-09: org-scoped read (ordinary RLS via withOrgContext) — the installations to reconcile
 * against GitHub for this org. Active = suspended_at IS NULL AND revoked_at IS NULL, mirroring
 * `resolveInstallationOrg`'s definition of `active`.
 */
export async function listActiveInstallationsForOrg(
  tx: Db,
  orgId: string,
): Promise<Array<{ installationId: number }>> {
  const rows = await tx
    .select({ installationId: githubAppInstallations.installationId })
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.orgId, orgId),
        isNull(githubAppInstallations.suspendedAt),
        isNull(githubAppInstallations.revokedAt),
      ),
    );
  return rows.map((row) => ({ installationId: row.installationId }));
}

/**
 * W2-09: org-scoped read — our current github repositories (any revocation state), for the
 * reconcile diff. Reconcile decides active/revoked itself from `revokedAt`.
 */
export async function listOrgGithubRepositories(
  tx: Db,
  orgId: string,
): Promise<Array<{ id: string; externalId: string; revokedAt: Date | null }>> {
  const rows = await tx
    .select({
      id: repositories.id,
      externalId: repositories.externalId,
      revokedAt: repositories.revokedAt,
    })
    .from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.provider, 'github')));
  return rows
    .filter((row): row is { id: string; externalId: string; revokedAt: Date | null } => row.externalId !== null)
    .map((row) => ({ id: row.id, externalId: row.externalId, revokedAt: row.revokedAt }));
}

/**
 * Returns true iff a row for `installationId` existed and was updated (false
 * = unknown installation — caller maps this to `{ status: 'ignored', reason:
 * 'unknown_installation' }`). `COALESCE` makes a repeated/idempotent
 * `installation.deleted` delivery for an already-revoked installation a true
 * no-op: it never moves `revoked_at` forward on retry.
 */
export async function markInstallationRevoked(tx: Db, installationId: number): Promise<boolean> {
  const updated = await tx
    .update(githubAppInstallations)
    .set({
      revokedAt: sql`coalesce(${githubAppInstallations.revokedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(eq(githubAppInstallations.installationId, installationId))
    .returning({ id: githubAppInstallations.id });
  return updated.length > 0;
}

/** Returns true iff a row for `installationId` existed and was updated (false = unknown installation). */
export async function setInstallationSuspended(
  tx: Db,
  installationId: number,
  suspended: boolean,
): Promise<boolean> {
  const updated = await tx
    .update(githubAppInstallations)
    .set({ suspendedAt: suspended ? new Date() : null, updatedAt: new Date() })
    .where(eq(githubAppInstallations.installationId, installationId))
    .returning({ id: githubAppInstallations.id });
  return updated.length > 0;
}

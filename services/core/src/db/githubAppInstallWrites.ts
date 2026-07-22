// Tenant-scoped writers for the GitHub App install flow (W1-06). Every export
// here takes a `tx: Db` that the CALLER has already produced via
// `withOrgContext(db, orgId, fn)` (services/core/src/db/client.ts) — none of
// these functions open their own transaction or set `app.org_id` themselves.
//
// Deliberately kept separate from `db/installations.ts`: that module's
// `resolveInstallationOrg` is the privileged, PRE-tenant-context read (it runs
// BEFORE org_id is known, on the login role, outside RLS) — a fundamentally
// different trust boundary from these tenant-scoped writes, which only ever
// run once `app.org_id` is already set for the current transaction.
//
// No schema migration required: `github_app_installations` and `repositories`
// already exist with every column this ticket needs (see spec.md).

import { eq, sql } from 'drizzle-orm';
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

/** Upsert on (org_id, provider='github', external_id=providerRepoId) — the existing composite unique index. */
export async function registerRepository(
  tx: Db,
  row: { orgId: string; providerRepoId: string; fullName: string; defaultBranch: string | null },
): Promise<{ repoId: string }> {
  const [inserted] = await tx
    .insert(repositories)
    .values({
      orgId: row.orgId,
      name: row.fullName,
      provider: 'github',
      externalId: row.providerRepoId,
      defaultBranch: row.defaultBranch,
    })
    .onConflictDoUpdate({
      target: [repositories.orgId, repositories.provider, repositories.externalId],
      set: {
        name: row.fullName,
        defaultBranch: row.defaultBranch,
        updatedAt: new Date(),
      },
    })
    .returning({ id: repositories.id });

  return { repoId: inserted.id };
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

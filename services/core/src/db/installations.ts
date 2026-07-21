// Privileged installation -> org resolver used ONLY by the GitHub webhook receiver
// (services/core/src/services/githubWebhookService.ts) to resolve tenant context
// BEFORE any `app.org_id` session context exists — org_id is the very thing being
// resolved here, so this intentionally runs outside `withOrgContext`
// (see db/client.ts). Mirrors the shape of agent-key resolution referenced in the
// `githubAppInstallations` JSDoc in db/schema.ts.

import { eq } from 'drizzle-orm';
import { createDb, createPoolFromSecret, type Db } from './client';
import { githubAppInstallations } from './schema';

/**
 * Privileged, pre-tenant-context lookup: installation id -> org. Runs on the
 * login-role pool WITHOUT `withOrgContext` because org_id is the very thing being
 * resolved. `active` = suspended_at IS NULL AND revoked_at IS NULL. Returns null
 * when no row matches (unknown/never-installed installation id).
 *
 * PRODUCTION GAP (documented, not fixed, per spec.md O-4): `github_app_installations`
 * carries org_id RLS. In local dev/test the login role (`sayre_dev`) is a superuser
 * and bypasses RLS, so this plain query works today. Production needs a sanctioned
 * pre-tenant read path for this one bootstrap lookup — either a minimally-privileged
 * read role with a SELECT-only policy on this table, or an explicit owner/service
 * connection — before this code is safe to run against a production database. That
 * role/policy decision is out of scope for W1-02.
 */
export async function resolveInstallationOrg(
  db: Db,
  installationId: number,
): Promise<{ orgId: string; active: boolean } | null> {
  const rows = await db
    .select({
      orgId: githubAppInstallations.orgId,
      suspendedAt: githubAppInstallations.suspendedAt,
      revokedAt: githubAppInstallations.revokedAt,
    })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    orgId: row.orgId,
    active: row.suspendedAt === null && row.revokedAt === null,
  };
}

let runtimeDbPending: Promise<Db> | null = null;

/** Lazily memoized runtime Db (createDb(await createPoolFromSecret())) for the default deps. */
export async function getRuntimeDb(): Promise<Db> {
  if (!runtimeDbPending) {
    runtimeDbPending = createPoolFromSecret().then((pool) => createDb(pool));
  }
  return runtimeDbPending;
}

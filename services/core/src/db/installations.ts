// Narrow installation -> org resolver used by GitHub webhook routing, lifecycle
// handling, and install-conflict checks. org_id is the output of this lookup, so
// ordinary `withOrgContext` cannot be used. Migration 0011 provides the only
// exception: a SECURITY DEFINER function owned by a NOLOGIN/NOBYPASSRLS role that
// can read four columns and returns only org_id + active.

import { sql } from 'drizzle-orm';
import { createDb, createPoolFromSecret, type Db } from './client';

export class InstallationResolutionInputError extends Error {
  constructor() {
    super('Installation id must be a positive safe integer.');
    this.name = 'InstallationResolutionInputError';
  }
}

/**
 * Pre-tenant lookup: installation id -> org. The transaction first drops to
 * `sayre_app` and clears any transaction-local org setting, then invokes the
 * migration-owned resolver function. Direct table access remains FORCE-RLS
 * scoped; this call cannot return account metadata or accept an org id.
 *
 * `active` = suspended_at IS NULL AND revoked_at IS NULL. Returns null when no
 * row matches (unknown/never-installed installation id). Missing/unsafe database
 * provisioning fails closed as a database error; startup validates the same
 * boundary before the HTTP listener opens.
 */
export async function resolveInstallationOrg(
  db: Db,
  installationId: number,
): Promise<{ orgId: string; active: boolean } | null> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new InstallationResolutionInputError();
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select org_id, active
        from public.resolve_github_installation_org(${installationId}::bigint)
    `);
  });

  const rows = (result as unknown as {
    rows: Array<{ org_id: string; active: boolean }>;
  }).rows;
  const row = rows[0];
  if (!row) return null;

  return {
    orgId: row.org_id,
    active: row.active,
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

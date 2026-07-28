// Pre-tenant + tenant-scoped lookups the Jira ticket poll loop needs.
// org_id is the OUTPUT of `listActiveJiraOrgIds`, so ordinary `withOrgContext`
// cannot be used for it -- migration 0017 provides the only exception, the
// same shape as `db/installations.ts::resolveInstallationOrg` (migration
// 0011): a SECURITY DEFINER function owned by a NOLOGIN/NOBYPASSRLS role that
// can read only `org_id` + `revoked_at`, filtered to non-revoked rows, no
// tenant-controlled input accepted at all.

import { sql } from 'drizzle-orm';
import { and, eq, isNull } from 'drizzle-orm';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { repositories } from './schema';

export interface ActiveJiraRepository {
  id: string;
  defaultBranch: string | null;
}

/**
 * Pre-tenant lookup: every org with an active (non-revoked) Jira connection.
 * The transaction first drops to `sayre_app` and clears any transaction-local
 * org setting, then invokes the migration-owned resolver function. Direct
 * table access remains FORCE-RLS scoped; this call cannot return anything
 * beyond the org id.
 */
export async function listActiveJiraOrgIds(db: Db): Promise<string[]> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select org_id from public.list_active_jira_connection_org_ids()
    `);
  });

  const rows = (result as unknown as { rows: Array<{ org_id: string }> }).rows;
  return rows.map((row) => row.org_id);
}

/** Ordinary tenant-scoped read: an org's non-revoked repositories (id + default branch only -- all the poller needs to build a sync scope). */
export async function listActiveJiraRepositories(
  db: Db,
  orgId: string,
): Promise<ActiveJiraRepository[]> {
  return withOrgContext(db, orgId, async (tx) => {
    const rows = await tx
      .select({ id: repositories.id, defaultBranch: repositories.defaultBranch })
      .from(repositories)
      .where(and(eq(repositories.orgId, orgId), isNull(repositories.revokedAt)));
    return rows;
  });
}

export { getRuntimeDb };

// W7-01 (OQ-3): the CROSS-TENANT dispatcher boundary over `github_installation_sync`'s
// dispatch/lease bookkeeping columns — structurally identical to
// `db/githubInitialParseOutbox.ts`: each function opens its own transaction, executes
// `set local role sayre_app`, clears `app.org_id`, and calls exactly one of migration 0020's
// SECURITY DEFINER functions. No table access, no admin DSN, no `org_id` from anywhere but the
// row itself.
//
// Deliberately a separate file from `db/githubInstallationSyncStore.ts` (the tenant-scoped
// store) so the trust boundary is greppable: nothing in that file touches lease/dispatch
// columns, and nothing here touches counters, the cursor, or the requesting subject.

import { sql } from 'drizzle-orm';
import type { InstallationSyncReason } from './githubInstallationSyncStore';
import type { Db } from './client';

export interface ClaimedInstallationDiscovery {
  id: string;
  leaseToken: string;
  orgId: string; // server-side truth from the row — becomes envelope.org_id
  installationId: number;
  runId: string;
  reason: InstallationSyncReason;
  dispatchAttemptCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
}

function assertBoundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

/** Lease a bounded due batch across tenants. batchSize 0..25, leaseSeconds 10..300. */
export async function claimInstallationDiscoveryOutbox(
  db: Db,
  batchSize: number,
  leaseSeconds: number,
): Promise<ClaimedInstallationDiscovery[]> {
  assertBoundedInteger(batchSize, 'batchSize', 0, 25);
  assertBoundedInteger(leaseSeconds, 'leaseSeconds', 10, 300);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select id, lease_token, org_id, installation_id, run_id, reason, dispatch_attempt_count
        from public.claim_github_installation_discovery(
          ${batchSize}::integer,
          ${leaseSeconds}::integer
        )
    `);
  });

  const rows = (
    result as unknown as {
      rows: Array<{
        id: string;
        lease_token: string;
        org_id: string;
        installation_id: number | string;
        run_id: string;
        reason: string;
        dispatch_attempt_count: number;
      }>;
    }
  ).rows;

  return rows.map((row) => {
    assertUuid(row.id, 'claimed installation discovery id');
    assertUuid(row.lease_token, 'claimed installation discovery lease token');
    assertUuid(row.org_id, 'claimed installation discovery org id');
    assertUuid(row.run_id, 'claimed installation discovery run id');
    if (row.reason !== 'app_install' && row.reason !== 'manual_reconcile') {
      throw new Error('claimed installation discovery row has an invalid reason.');
    }
    const installationId = Number(row.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error('claimed installation discovery row has an invalid installation id.');
    }
    return {
      id: row.id,
      leaseToken: row.lease_token,
      orgId: row.org_id,
      installationId,
      runId: row.run_id,
      reason: row.reason,
      dispatchAttemptCount: row.dispatch_attempt_count,
    };
  });
}

/**
 * Mark dispatched for the current lease owner only. Unlike 0012's terminal `delivered_at`, this
 * is a WATCHDOG re-arm: it sets `dispatched_at = now()`, clears the lease, and sets
 * `next_attempt_at = now() + redispatchSeconds` so a run that neither progresses (heartbeat) nor
 * terminates becomes due again — this is what survives a total Redis loss (AC-20).
 * redispatchSeconds 30..3600.
 */
export async function completeInstallationDiscoveryOutbox(
  db: Db,
  id: string,
  leaseToken: string,
  redispatchSeconds: number,
): Promise<boolean> {
  assertUuid(id, 'installation discovery outbox id');
  assertUuid(leaseToken, 'installation discovery outbox lease token');
  assertBoundedInteger(redispatchSeconds, 'redispatchSeconds', 30, 3600);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select public.complete_github_installation_discovery(
        ${id}::uuid,
        ${leaseToken}::uuid,
        ${redispatchSeconds}::integer
      ) as completed
    `);
  });

  const row = (result as unknown as { rows: Array<{ completed: boolean }> }).rows[0];
  return row?.completed === true;
}

/** Release the lease with a bounded delay after a failed enqueue. delaySeconds 1..300. */
export async function retryInstallationDiscoveryOutbox(
  db: Db,
  id: string,
  leaseToken: string,
  delaySeconds: number,
): Promise<boolean> {
  assertUuid(id, 'installation discovery outbox id');
  assertUuid(leaseToken, 'installation discovery outbox lease token');
  assertBoundedInteger(delaySeconds, 'delaySeconds', 1, 300);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return tx.execute(sql`
      select public.retry_github_installation_discovery(
        ${id}::uuid,
        ${leaseToken}::uuid,
        ${delaySeconds}::integer
      ) as released
    `);
  });

  const row = (result as unknown as { rows: Array<{ released: boolean }> }).rows[0];
  return row?.released === true;
}

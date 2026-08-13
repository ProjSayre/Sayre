// W7-01: tenant-scoped readers/writers for the `github_installation_sync` run row. Every
// export here takes a `tx: Db` the caller already produced via `withOrgContext` — none of
// these functions open their own transaction or set `app.org_id` themselves (mirrors
// `db/githubAppInstallWrites.ts`'s header convention).
//
// This row doubles as the transactional outbox for the paginated discovery job (OQ-3): the
// dispatch/lease bookkeeping columns (`lease_token`, `lease_expires_at`, `dispatched_at`,
// `dispatch_attempt_count`) are deliberately NOT touched here — `sayre_app` holds no grant on
// them at all (migration 0020). Only `db/githubInstallationDiscoveryOutbox.ts`'s cross-tenant
// dispatcher boundary functions may read/write those columns.

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { githubInstallationSync } from './schema';

export type InstallationSyncStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
export type InstallationSyncReason = 'app_install' | 'manual_reconcile';
/** Fixed enum — NEVER a provider message, URL, or repository name. */
export type InstallationSyncErrorCode =
  | 'provider_unavailable'
  | 'page_limit_exceeded'
  | 'internal_error';
/** OQ-4: why the destructive sweep did or did not revoke anything on this run. */
export type InstallationSweepOutcome =
  | 'not_applicable' // app_install run, or run never reached `complete`
  | 'applied'
  | 'withheld_coverage' // an active installation of this org has no completed run
  | 'withheld_empty_result' // GitHub reported 0 repos while the org holds >=1 active
  | 'withheld_ratio'; // candidates exceeded the blast-radius bound

/** OQ-4 audit: who asked for the run. Captured server-side from AuthContext, never client input. */
export interface InstallationSyncSubject {
  subjectType: 'user' | 'agent_key';
  subjectId: string;
}

export interface InstallationSyncRow {
  installationId: number;
  runId: string;
  status: InstallationSyncStatus;
  reason: InstallationSyncReason;
  nextPage: number;
  totalCount: number | null;
  discoveredCount: number;
  registeredCount: number;
  enqueuedCount: number;
  revokedCount: number;
  sweepOutcome: InstallationSweepOutcome;
  attemptCount: number;
  dispatchAttemptCount: number;
  lastErrorCode: InstallationSyncErrorCode | null;
  requestedBy: InstallationSyncSubject | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  completedRunId: string | null;
}

/** Also the dispatcher's own redispatch watchdog interval (INSTALLATION_DISCOVERY_REDISPATCH_SECONDS). */
export const INSTALLATION_SYNC_STALL_MS = 5 * 60_000;
const INSTALLATION_SYNC_STALL_SECONDS = INSTALLATION_SYNC_STALL_MS / 1000;

function whereRun(orgId: string, installationId: number, runId: string) {
  return and(
    eq(githubInstallationSync.orgId, orgId),
    eq(githubInstallationSync.installationId, installationId),
    eq(githubInstallationSync.runId, runId),
  );
}

/**
 * Upsert on (org_id, installation_id). Resets run state (fresh `run_id`, cursor 1, counts 0,
 * attempts 0, sweep outcome 'not_applicable', `next_attempt_at = now()` so the dispatcher picks
 * it up) UNLESS the existing row is `running` and was touched within INSTALLATION_SYNC_STALL_MS
 * — in that case the live run is left alone and this returns `{ reset: false }` with the LIVE
 * run's id (EC-20). `completed_run_id` is preserved across resets (the sweep's coverage input).
 */
export async function startInstallationSync(
  tx: Db,
  row: {
    orgId: string;
    installationId: number;
    reason: InstallationSyncReason;
    requestedBy: InstallationSyncSubject | null;
  },
): Promise<{ reset: boolean; runId: string }> {
  const now = new Date();
  const stallThreshold = new Date(now.getTime() - INSTALLATION_SYNC_STALL_MS);

  const resetFields = {
    reason: row.reason,
    status: 'pending' as const,
    nextPage: 1,
    totalCount: null,
    discoveredCount: 0,
    registeredCount: 0,
    enqueuedCount: 0,
    revokedCount: 0,
    sweepOutcome: 'not_applicable' as const,
    attemptCount: 0,
    lastErrorCode: null,
    requestedBySubjectType: row.requestedBy?.subjectType ?? null,
    requestedBySubjectId: row.requestedBy?.subjectId ?? null,
    nextAttemptAt: now,
    startedAt: now,
    completedAt: null,
  };

  const [inserted] = await tx
    .insert(githubInstallationSync)
    .values({ orgId: row.orgId, installationId: row.installationId, ...resetFields })
    .onConflictDoUpdate({
      target: [githubInstallationSync.orgId, githubInstallationSync.installationId],
      // A live (running, recently touched) run is left alone — the conflicting row is
      // neither inserted nor updated, and RETURNING yields no row for it.
      setWhere: sql`NOT (${githubInstallationSync.status} = 'running' AND ${githubInstallationSync.updatedAt} > ${stallThreshold})`,
      set: {
        ...resetFields,
        // Fresh run id on every reset. completed_run_id is intentionally NOT included
        // here — it survives a reset as the sweep's coverage input.
        runId: sql`gen_random_uuid()`,
        updatedAt: now,
      },
    })
    .returning({ runId: githubInstallationSync.runId });

  if (inserted) {
    return { reset: true, runId: inserted.runId };
  }

  const [live] = await tx
    .select({ runId: githubInstallationSync.runId })
    .from(githubInstallationSync)
    .where(
      and(
        eq(githubInstallationSync.orgId, row.orgId),
        eq(githubInstallationSync.installationId, row.installationId),
      ),
    );
  if (!live) {
    throw new Error('startInstallationSync: expected an existing live run row.');
  }
  return { reset: false, runId: live.runId };
}

/**
 * Moves pending|failed|running -> running, bumps attempt_count, pushes the redispatch watchdog
 * forward, and returns the resume cursor. `expectedRunId` guards a stale redispatch: a job for a
 * run that has since been reset returns null rather than resuming under the new run's counters.
 *
 * Also returns `reason`, re-read from the row itself at claim time — this is the ONLY input the
 * OQ-4 destructive sweep's authorization guard (`computeRevokeSweep` in
 * `services/githubInstallationDiscoveryService.ts`) may use (AC-25, EC-38). The queue envelope
 * also carries a `reason` field, but that copy is dispatcher-authored and purely informational —
 * a worker never treats it as authoritative, precisely because it is transport, not the row.
 */
export async function claimInstallationSync(
  tx: Db,
  key: { orgId: string; installationId: number; expectedRunId: string },
): Promise<{ nextPage: number; runId: string; startedAt: Date; reason: InstallationSyncReason } | null> {
  const now = new Date();
  const [claimed] = await tx
    .update(githubInstallationSync)
    .set({
      status: 'running',
      attemptCount: sql`${githubInstallationSync.attemptCount} + 1`,
      nextAttemptAt: sql`${now} + make_interval(secs => ${INSTALLATION_SYNC_STALL_SECONDS})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(githubInstallationSync.orgId, key.orgId),
        eq(githubInstallationSync.installationId, key.installationId),
        eq(githubInstallationSync.runId, key.expectedRunId),
        sql`${githubInstallationSync.status} IN ('pending', 'failed', 'running')`,
      ),
    )
    .returning({
      nextPage: githubInstallationSync.nextPage,
      runId: githubInstallationSync.runId,
      startedAt: githubInstallationSync.startedAt,
      reason: githubInstallationSync.reason,
    });
  if (!claimed) return null;
  return { ...claimed, reason: claimed.reason as InstallationSyncReason };
}

/**
 * Compare-and-set page bookkeeping: applies ONLY when the stored cursor still equals
 * `expectedPage`, status is 'running', and run_id still equals `runId`. Returns false when
 * another runner already advanced past this page (the caller must then stop as superseded) —
 * this is what makes a replayed or concurrent page a no-op for the counters (AC-15, EC-10,
 * EC-11). Also acts as the run's HEARTBEAT: it pushes `next_attempt_at` to
 * `now() + INSTALLATION_DISCOVERY_REDISPATCH_SECONDS`, so a progressing run is never
 * redispatched underneath itself (AC-23).
 */
export async function advanceInstallationSyncPage(
  tx: Db,
  input: {
    orgId: string;
    installationId: number;
    runId: string;
    expectedPage: number;
    totalCount: number | null;
    discoveredDelta: number;
    registeredDelta: number;
    enqueuedDelta: number;
  },
): Promise<boolean> {
  const now = new Date();
  const result = await tx
    .update(githubInstallationSync)
    .set({
      nextPage: input.expectedPage + 1,
      totalCount: input.totalCount,
      discoveredCount: sql`${githubInstallationSync.discoveredCount} + ${input.discoveredDelta}`,
      registeredCount: sql`${githubInstallationSync.registeredCount} + ${input.registeredDelta}`,
      enqueuedCount: sql`${githubInstallationSync.enqueuedCount} + ${input.enqueuedDelta}`,
      nextAttemptAt: sql`${now} + make_interval(secs => ${INSTALLATION_SYNC_STALL_SECONDS})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(githubInstallationSync.orgId, input.orgId),
        eq(githubInstallationSync.installationId, input.installationId),
        eq(githubInstallationSync.runId, input.runId),
        eq(githubInstallationSync.nextPage, input.expectedPage),
        eq(githubInstallationSync.status, 'running'),
      ),
    )
    .returning({ id: githubInstallationSync.id });
  return result.length > 0;
}

/** Terminal: status='complete', completed_at=now(), completed_run_id=run_id, lease cleared. */
export async function completeInstallationSync(
  tx: Db,
  key: { orgId: string; installationId: number; runId: string },
): Promise<void> {
  const now = new Date();
  await tx
    .update(githubInstallationSync)
    .set({ status: 'complete', completedAt: now, completedRunId: key.runId, updatedAt: now })
    .where(whereRun(key.orgId, key.installationId, key.runId));
}

export async function failInstallationSync(
  tx: Db,
  input: {
    orgId: string;
    installationId: number;
    runId: string;
    errorCode: InstallationSyncErrorCode;
  },
): Promise<void> {
  await tx
    .update(githubInstallationSync)
    .set({ status: 'failed', lastErrorCode: input.errorCode, updatedAt: new Date() })
    .where(whereRun(input.orgId, input.installationId, input.runId));
}

export async function cancelInstallationSync(
  tx: Db,
  key: { orgId: string; installationId: number; runId: string },
): Promise<void> {
  await tx
    .update(githubInstallationSync)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(whereRun(key.orgId, key.installationId, key.runId));
}

/** OQ-4: records the sweep result on the run row (the audit record). */
export async function recordSweepOutcome(
  tx: Db,
  input: {
    orgId: string;
    installationId: number;
    runId: string;
    outcome: InstallationSweepOutcome;
    revokedCount: number;
  },
): Promise<void> {
  await tx
    .update(githubInstallationSync)
    .set({ sweepOutcome: input.outcome, revokedCount: input.revokedCount, updatedAt: new Date() })
    .where(whereRun(input.orgId, input.installationId, input.runId));
}

/** All rows for one org (RLS + explicit org predicate). Never crosses orgs. */
export async function listInstallationSyncRows(
  tx: Db,
  orgId: string,
): Promise<InstallationSyncRow[]> {
  const rows = await tx
    .select()
    .from(githubInstallationSync)
    .where(eq(githubInstallationSync.orgId, orgId));

  return rows.map((row) => ({
    installationId: row.installationId,
    runId: row.runId,
    status: row.status as InstallationSyncStatus,
    reason: row.reason as InstallationSyncReason,
    nextPage: row.nextPage,
    totalCount: row.totalCount,
    discoveredCount: row.discoveredCount,
    registeredCount: row.registeredCount,
    enqueuedCount: row.enqueuedCount,
    revokedCount: row.revokedCount,
    sweepOutcome: row.sweepOutcome as InstallationSweepOutcome,
    attemptCount: row.attemptCount,
    dispatchAttemptCount: row.dispatchAttemptCount,
    lastErrorCode: row.lastErrorCode as InstallationSyncErrorCode | null,
    requestedBy:
      row.requestedBySubjectType && row.requestedBySubjectId
        ? {
            subjectType: row.requestedBySubjectType as InstallationSyncSubject['subjectType'],
            subjectId: row.requestedBySubjectId,
          }
        : null,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    completedRunId: row.completedRunId,
  }));
}

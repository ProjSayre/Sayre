// W7-01: paginated GitHub installation discovery worker + the OQ-4 destructive revoke sweep.
// Business logic lives here per .claude/rules/service-layer.md; the git-sync worker
// (integrations/git/worker.ts) is the thin BullMQ adapter that calls `runInstallationDiscovery`.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): `org_id` is taken ONLY
// from `envelope.org_id` (itself written server-side from the leased outbox row at dispatch
// time — see db/githubInstallationDiscoveryOutbox.ts), and is RE-VERIFIED against
// `resolveInstallationOrg` before any write. Every tenant read/write runs inside
// `withOrgContext` (AC-13) — the one deliberate exception is `claimInstallationSync`, whose
// default production binding self-manages its own `withOrgContext` call rather than sharing the
// injected `deps.withOrg` transaction the page/completion writes use; this keeps the claim a
// single, standalone CAS step that always resolves before any page transaction opens.
//
// OQ-4 (destructive direction): `runRevokeSweep` below is the ONLY place `markRepositoryRevoked`
// is called from a discovery run, and it only ever runs for a `manual_reconcile` run that
// reaches `complete` — the authorization decision is read from the row's own stored `reason`,
// never from request input (AC-25, EC-38).
//
// FND-cf76b24c5057 remediation: the sweep's `reason` gate reads `claimed.reason` — the value
// `claimInstallationSync` re-derives from the row itself at claim time (see
// db/githubInstallationSyncStore.ts) — NEVER `envelope.payload.reason`. The queue payload's own
// `reason` field still exists (it feeds `buildInstallationDiscoveryEnvelope`'s `source` and is
// useful for logging/debugging), but it is a transport-layer copy the dispatcher wrote at publish
// time, not something a worker may treat as authorization input; the row, re-read independently
// by the worker, is the sole authority.

import type { RepoInitialParseEvent } from '@sayre/shared-types';
import type { GithubAppClient } from '../github/appClient';
import { createDefaultGithubAppClient } from '../github/appClient';
import { getRuntimeDb, resolveInstallationOrg as resolveInstallationOrgLookup } from '../db/installations';
import { withOrgContext, type Db } from '../db/client';
import {
  advanceInstallationSyncPage as storeAdvanceInstallationSyncPage,
  cancelInstallationSync as storeCancelInstallationSync,
  claimInstallationSync as storeClaimInstallationSync,
  completeInstallationSync as storeCompleteInstallationSync,
  failInstallationSync as storeFailInstallationSync,
  recordSweepOutcome as storeRecordSweepOutcome,
  startInstallationSync,
  type InstallationSweepOutcome,
  type InstallationSyncErrorCode,
  type InstallationSyncReason,
  type InstallationSyncSubject,
} from '../db/githubInstallationSyncStore';
import {
  countActiveGithubRepositories as storeCountActiveGithubRepositories,
  listRevokeSweepCandidates as storeListRevokeSweepCandidates,
  markRepositoryRevoked as storeMarkRepositoryRevoked,
  registerRepository as storeRegisterRepository,
} from '../db/githubAppInstallWrites';
import { listActiveInstallationsForOrg as storeListActiveInstallationsForOrg } from '../db/githubAppInstallWrites';
import { listInstallationSyncRows as storeListInstallationSyncRows } from '../db/githubInstallationSyncStore';
import { enqueueInitialParseOutbox } from '../db/githubInitialParseOutbox';
import { kickInitialParseOutboxDispatcher } from './initialParseOutboxWake';
import { kickInstallationDiscoveryDispatcher } from './installationDiscoveryWake';
import { buildInitialParseEnvelope } from './githubAppInstallService';
import type { GithubInstallationDiscoveryPayload } from '../queue/bullmq';
import { GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE } from '../queue/bullmq';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';

export const INSTALLATION_DISCOVERY_TARGET_MS = 60_000; // AC-8 product bound (OQ-1, confirmed)
export const MAX_INSTALLATION_DISCOVERY_PAGES = 100; // runaway guard ~= 10,000 repos
/** OQ-4 blast-radius bound: a sweep may revoke at most this fraction of the org's active
 *  GitHub repositories, unless the candidate count is at or below MIN_SWEEP_RATIO_EXEMPT_ROWS. */
export const MAX_SWEEP_REVOKE_FRACTION = 0.5;
export const MIN_SWEEP_RATIO_EXEMPT_ROWS = 10;

export interface QueueInstallationDiscoveryDeps {
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  startInstallationSync: typeof startInstallationSync;
  kickDiscoveryDispatcher: () => void; // REPLACES a direct enqueueJob dependency (OQ-3)
}

async function defaultWithOrg<T>(orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(await getRuntimeDb(), orgId, fn);
}

const defaultQueueDeps: QueueInstallationDiscoveryDeps = {
  withOrg: defaultWithOrg,
  startInstallationSync,
  kickDiscoveryDispatcher: kickInstallationDiscoveryDispatcher,
};

/**
 * OQ-3: writes the durable row ONLY (inside its own org transaction), then kicks the dispatcher
 * after commit as a latency optimization. It NEVER calls BullMQ `enqueue()` — losing the kick
 * costs latency, never the job.
 */
export async function queueInstallationDiscovery(
  input: {
    orgId: string;
    installationId: number;
    reason: InstallationSyncReason;
    requestedBy: InstallationSyncSubject | null;
  },
  deps: Partial<QueueInstallationDiscoveryDeps> = {},
): Promise<{ status: 'queued'; runId: string; reset: boolean }> {
  const resolved = { ...defaultQueueDeps, ...deps };
  const { reset, runId } = await resolved.withOrg(input.orgId, (tx) =>
    resolved.startInstallationSync(tx, {
      orgId: input.orgId,
      installationId: input.installationId,
      reason: input.reason,
      requestedBy: input.requestedBy,
    }),
  );
  resolved.kickDiscoveryDispatcher();
  return { status: 'queued', runId, reset };
}

/** Called by the DISPATCHER, from a claimed row's server-side fields. */
export function buildInstallationDiscoveryEnvelope(input: {
  orgId: string;
  installationId: number;
  runId: string;
  reason: InstallationSyncReason;
}): MessageEnvelope<GithubInstallationDiscoveryPayload> {
  return makeEnvelope<GithubInstallationDiscoveryPayload>({
    org_id: input.orgId,
    type: GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE,
    source: input.reason === 'app_install' ? 'github-app-install' : 'github-reconcile',
    trace_id: `installation:${input.installationId}`,
    idempotency_key: ['github', 'installation_discovery', input.installationId, input.runId].join(
      ':',
    ),
    payload: {
      provider: 'github',
      type: 'installation_discovery',
      installation_id: String(input.installationId),
      run_id: input.runId,
      reason: input.reason,
    },
  });
}

export interface InstallationDiscoveryDeps {
  resolveInstallationOrg: (
    installationId: number,
  ) => Promise<{ orgId: string; active: boolean } | null>;
  githubClient: GithubAppClient;
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  claimInstallationSync: typeof storeClaimInstallationSync;
  advanceInstallationSyncPage: typeof storeAdvanceInstallationSyncPage;
  // completeInstallationSync shares the last page's real transaction (tx-first, exactly
  // `typeof completeInstallationSync`). cancelInstallationSync/failInstallationSync/
  // recordSweepOutcome are standalone, input-only calls — a deliberate, disclosed deviation
  // from spec.md's literal `typeof X` (tx-first) declaration for these three; see changes.md.
  completeInstallationSync: typeof storeCompleteInstallationSync;
  failInstallationSync: (input: {
    orgId: string;
    installationId: number;
    runId: string;
    errorCode: InstallationSyncErrorCode;
  }) => Promise<void>;
  cancelInstallationSync: (input: {
    orgId: string;
    installationId: number;
    runId: string;
  }) => Promise<void>;
  recordSweepOutcome: (input: {
    orgId: string;
    installationId: number;
    runId: string;
    outcome: InstallationSweepOutcome;
    revokedCount: number;
  }) => Promise<void>;
  registerRepository: typeof storeRegisterRepository; // now called WITH discoveryRunId
  enqueueInitialParse: (tx: Db, e: MessageEnvelope<RepoInitialParseEvent>) => Promise<void>;
  kickInitialParseOutbox: () => void;
  // OQ-4 sweep dependencies:
  listActiveInstallationsForOrg: typeof storeListActiveInstallationsForOrg;
  listInstallationSyncRows: typeof storeListInstallationSyncRows;
  listRevokeSweepCandidates: typeof storeListRevokeSweepCandidates;
  countActiveGithubRepositories: typeof storeCountActiveGithubRepositories;
  markRepositoryRevoked: typeof storeMarkRepositoryRevoked;
}

export interface InstallationSweepResult {
  outcome: InstallationSweepOutcome;
  revoked: number;
}

export type InstallationDiscoveryResult =
  | {
      status: 'complete';
      pages: number;
      discovered: number;
      registered: number;
      enqueued: number;
      sweep: InstallationSweepResult;
    }
  | {
      status: 'cancelled';
      reason: 'unknown_installation' | 'org_mismatch' | 'inactive_installation' | 'superseded' | 'no_row';
    }
  | { status: 'failed'; errorCode: InstallationSyncErrorCode; nextPage: number };

/**
 * The store's `claimInstallationSync(tx, key)` signature requires a `tx: Db` already produced
 * via `withOrgContext` — but this call deliberately happens BEFORE any page/completion
 * transaction opens (it is a standalone CAS step, not sharing a transaction with anything else).
 * The default production binding therefore ignores the placeholder `tx` it is invoked with and
 * manages its own `withOrgContext` call internally; the signature still matches
 * `typeof claimInstallationSync` exactly, as spec.md requires.
 */
async function defaultClaimInstallationSync(
  _tx: Db,
  key: { orgId: string; installationId: number; expectedRunId: string },
) {
  return withOrgContext(await getRuntimeDb(), key.orgId, (tx) => storeClaimInstallationSync(tx, key));
}

async function defaultResolveInstallationOrg(
  installationId: number,
): Promise<{ orgId: string; active: boolean } | null> {
  return resolveInstallationOrgLookup(await getRuntimeDb(), installationId);
}

/**
 * Standalone (input-only) writes each open their own `withOrgContext` transaction — they never
 * share a transaction with the page-processing writes (register/enqueue/advance), which is
 * consistent with being called OUTSIDE any `deps.withOrg` block the caller opens.
 */
async function defaultCancelInstallationSync(input: {
  orgId: string;
  installationId: number;
  runId: string;
}): Promise<void> {
  await withOrgContext(await getRuntimeDb(), input.orgId, (tx) =>
    storeCancelInstallationSync(tx, input),
  );
}

async function defaultFailInstallationSync(input: {
  orgId: string;
  installationId: number;
  runId: string;
  errorCode: InstallationSyncErrorCode;
}): Promise<void> {
  await withOrgContext(await getRuntimeDb(), input.orgId, (tx) =>
    storeFailInstallationSync(tx, input),
  );
}

async function defaultRecordSweepOutcome(input: {
  orgId: string;
  installationId: number;
  runId: string;
  outcome: InstallationSweepOutcome;
  revokedCount: number;
}): Promise<void> {
  await withOrgContext(await getRuntimeDb(), input.orgId, (tx) =>
    storeRecordSweepOutcome(tx, input),
  );
}

const defaultDeps: InstallationDiscoveryDeps = {
  resolveInstallationOrg: defaultResolveInstallationOrg,
  githubClient: createDefaultGithubAppClient(),
  withOrg: defaultWithOrg,
  claimInstallationSync: defaultClaimInstallationSync,
  advanceInstallationSyncPage: storeAdvanceInstallationSyncPage,
  completeInstallationSync: storeCompleteInstallationSync,
  failInstallationSync: defaultFailInstallationSync,
  cancelInstallationSync: defaultCancelInstallationSync,
  recordSweepOutcome: defaultRecordSweepOutcome,
  registerRepository: storeRegisterRepository,
  enqueueInitialParse: enqueueInitialParseOutbox,
  kickInitialParseOutbox: kickInitialParseOutboxDispatcher,
  listActiveInstallationsForOrg: storeListActiveInstallationsForOrg,
  listInstallationSyncRows: storeListInstallationSyncRows,
  listRevokeSweepCandidates: storeListRevokeSweepCandidates,
  countActiveGithubRepositories: storeCountActiveGithubRepositories,
  markRepositoryRevoked: storeMarkRepositoryRevoked,
};

interface SweepContext {
  orgId: string;
  installationId: number;
  runId: string;
  reason: InstallationSyncReason;
  startedAt: Date;
  discovered: number;
}

/**
 * OQ-4 direction. Applies its guards in order, returning at the first refusal. Never logs a
 * repository name or provider text — only the outcome code and counts (AC-26).
 */
async function computeRevokeSweep(
  tx: Db,
  ctx: SweepContext,
  deps: InstallationDiscoveryDeps,
): Promise<InstallationSweepResult> {
  // 1. Authorization guard: only the admin-gated endpoint's runs may revoke.
  if (ctx.reason !== 'manual_reconcile') {
    return { outcome: 'not_applicable', revoked: 0 };
  }

  // 2. Coverage: every active installation of the org must have a completed run.
  const activeInstallations = await deps.listActiveInstallationsForOrg(tx, ctx.orgId);
  const syncRows = await deps.listInstallationSyncRows(tx, ctx.orgId);
  const completedRunIdByInstallation = new Map(
    syncRows.map((row) => [row.installationId, row.completedRunId]),
  );
  const observedRunIds: string[] = [];
  for (const installation of activeInstallations) {
    const completedRunId = completedRunIdByInstallation.get(installation.installationId);
    if (!completedRunId) {
      return { outcome: 'withheld_coverage', revoked: 0 };
    }
    observedRunIds.push(completedRunId);
  }

  const activeRepoCount = await deps.countActiveGithubRepositories(tx, ctx.orgId);

  // 3. Empty-result: GitHub suddenly reporting zero repos is far more likely a provider/scope
  //    problem than every repository having genuinely vanished.
  if (ctx.discovered === 0 && activeRepoCount > 0) {
    return { outcome: 'withheld_empty_result', revoked: 0 };
  }

  // 4. Blast-radius ratio.
  const candidates = await deps.listRevokeSweepCandidates(tx, {
    orgId: ctx.orgId,
    observedRunIds,
    runStartedAt: ctx.startedAt,
  });
  if (
    candidates.length > MIN_SWEEP_RATIO_EXEMPT_ROWS &&
    candidates.length > MAX_SWEEP_REVOKE_FRACTION * activeRepoCount
  ) {
    return { outcome: 'withheld_ratio', revoked: 0 };
  }

  // 5. Apply.
  let revoked = 0;
  for (const candidate of candidates) {
    const applied = await deps.markRepositoryRevoked(tx, {
      orgId: ctx.orgId,
      providerRepoId: candidate.externalId,
    });
    if (applied) revoked += 1;
  }
  return { outcome: 'applied', revoked };
}

/** Exactly one structured log line per sweep — outcome code, counts, installation id, org id.
 *  Never a repository name, provider message, or full response (AC-14, AC-26). */
async function runRevokeSweep(
  tx: Db,
  ctx: SweepContext,
  deps: InstallationDiscoveryDeps,
): Promise<InstallationSweepResult> {
  const result = await computeRevokeSweep(tx, ctx, deps);
  console.log(
    `[core] installation discovery sweep outcome=${result.outcome} revoked=${result.revoked} ` +
      `installation_id=${ctx.installationId} org_id=${ctx.orgId}`,
  );
  return result;
}

/** BullMQ handler. Throws (after marking the row failed) so BullMQ retries with backoff; the
 *  outbox watchdog is the durable backstop when BullMQ's own retries are lost entirely. */
export async function runInstallationDiscovery(
  envelope: MessageEnvelope<GithubInstallationDiscoveryPayload>,
  deps: Partial<InstallationDiscoveryDeps> = {},
): Promise<InstallationDiscoveryResult> {
  const resolved: InstallationDiscoveryDeps = { ...defaultDeps, ...deps };
  const orgId = envelope.org_id; // never from the payload
  const payload = envelope.payload;
  const installationId = Number(payload.installation_id);

  // Step (b): resolve + re-verify the installation BEFORE any write.
  const resolvedInstallation = await resolved.resolveInstallationOrg(installationId);
  if (!resolvedInstallation) {
    return { status: 'cancelled', reason: 'unknown_installation' };
  }
  if (resolvedInstallation.orgId !== orgId) {
    return { status: 'cancelled', reason: 'org_mismatch' };
  }
  if (!resolvedInstallation.active) {
    await resolved.cancelInstallationSync({ orgId, installationId, runId: payload.run_id });
    return { status: 'cancelled', reason: 'inactive_installation' };
  }

  // Step (c): claim the run — a standalone CAS step, ahead of any page transaction.
  const placeholderTx = undefined as unknown as Db;
  const claimed = await resolved.claimInstallationSync(placeholderTx, {
    orgId,
    installationId,
    expectedRunId: payload.run_id,
  });
  if (!claimed) {
    return { status: 'cancelled', reason: 'no_row' };
  }

  const runId = claimed.runId;
  const startPage = claimed.nextPage;
  let page = startPage;
  let pagesFetched = 0;
  let discoveredTotal = 0;
  let registeredTotal = 0;
  let enqueuedTotal = 0;

  for (;;) {
    if (page - startPage >= MAX_INSTALLATION_DISCOVERY_PAGES) {
      // EC-14: a retry cannot help; the dispatcher's due predicate excludes this error code.
      await resolved.failInstallationSync({
        orgId,
        installationId,
        runId,
        errorCode: 'page_limit_exceeded',
      });
      return { status: 'failed', errorCode: 'page_limit_exceeded', nextPage: page };
    }

    // Cheap, pre-transaction re-check: an installation suspended/uninstalled mid-discovery
    // must not write another repository or outbox row.
    const stillActive = await resolved.resolveInstallationOrg(installationId);
    if (!stillActive || stillActive.orgId !== orgId || !stillActive.active) {
      await resolved.cancelInstallationSync({ orgId, installationId, runId });
      return { status: 'cancelled', reason: 'inactive_installation' };
    }

    let pageResult;
    try {
      pageResult = await resolved.githubClient.listInstallationReposPage(installationId, page);
    } catch (error) {
      await resolved.failInstallationSync({
        orgId,
        installationId,
        runId,
        errorCode: 'provider_unavailable',
      });
      throw error; // BullMQ retries; cursor stays where it is (nothing committed this page).
    }

    const isLastPage = !pageResult.hasNextPage;
    const discoveredDelta = pageResult.repos.length;
    let registeredDelta = 0;
    let enqueuedDelta = 0;
    let anyEnqueued = false;
    let advanced = false;
    let sweep: InstallationSweepResult = { outcome: 'not_applicable', revoked: 0 };
    const startedAt = claimed.startedAt;

    // Approach step (g): a store error inside this transaction (registerRepository/
    // advanceInstallationSyncPage/enqueueInitialParse/completeInstallationSync/the sweep) must
    // ALSO mark the row failed with 'internal_error' and rethrow — not just a provider-fetch
    // failure (see the try/catch around the page fetch above). Without this, an uncaught store
    // error left the row stuck showing 'running'/stalled rather than a diagnosable 'failed', and
    // made 'internal_error' unreachable (review.md Warning 1 / Fix list item 3).
    try {
      await resolved.withOrg(orgId, async (tx) => {
        for (const repo of pageResult.repos) {
          const { repoId } = await resolved.registerRepository(tx, {
            orgId,
            providerRepoId: repo.provider_repo_id,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch,
            discoveryRunId: runId,
          });
          registeredDelta += 1;

          if (repo.default_branch && repo.default_branch_head_sha) {
            const initialParseEnvelope = buildInitialParseEnvelope({
              orgId,
              installationId,
              repoId,
              providerRepoId: repo.provider_repo_id,
              fullName: repo.full_name,
              ref: `refs/heads/${repo.default_branch}`,
              revisionSha: repo.default_branch_head_sha,
            });
            await resolved.enqueueInitialParse(tx, initialParseEnvelope);
            enqueuedDelta += 1;
            anyEnqueued = true;
          }
        }

        advanced = await resolved.advanceInstallationSyncPage(tx, {
          orgId,
          installationId,
          runId,
          expectedPage: page,
          totalCount: pageResult.totalCount,
          discoveredDelta,
          registeredDelta,
          enqueuedDelta,
        });
        // AC-15: superseded — another runner already advanced past this page. The transaction
        // still commits (the writes above are idempotent); the run itself stops here.
        if (!advanced) return;

        if (isLastPage) {
          await resolved.completeInstallationSync(tx, { orgId, installationId, runId });
          sweep = await runRevokeSweep(
            tx,
            {
              orgId,
              installationId,
              runId,
              // FND-cf76b24c5057: authorization reads the WORKER's own row read (`claimed.reason`,
              // re-derived by claimInstallationSync at claim time), never the queue envelope's
              // payload.reason — a queue payload is transport, not the row, and must never be able
              // to cause or target a sweep (AC-25, EC-38).
              reason: claimed.reason,
              startedAt,
              discovered: discoveredTotal + discoveredDelta,
            },
            resolved,
          );
        }
      });
    } catch (error) {
      await resolved.failInstallationSync({
        orgId,
        installationId,
        runId,
        errorCode: 'internal_error',
      });
      throw error; // BullMQ retries; the transaction above rolled back, so the cursor is unmoved.
    }

    if (anyEnqueued) resolved.kickInitialParseOutbox();

    if (advanced && isLastPage) {
      await resolved.recordSweepOutcome({
        orgId,
        installationId,
        runId,
        outcome: sweep.outcome,
        revokedCount: sweep.revoked,
      });
    }

    if (!advanced) {
      return { status: 'cancelled', reason: 'superseded' };
    }

    pagesFetched += 1;
    discoveredTotal += discoveredDelta;
    registeredTotal += registeredDelta;
    enqueuedTotal += enqueuedDelta;

    if (isLastPage) {
      return {
        status: 'complete',
        pages: pagesFetched,
        discovered: discoveredTotal,
        registered: registeredTotal,
        enqueued: enqueuedTotal,
        sweep,
      };
    }

    page += 1;
  }
}

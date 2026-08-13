// W7-01 — genuine end-to-end wiring coverage, added per review's fix list (a disclosed
// spec-conformance gap found after `red` already ran, not dev inventing its own spec): spec.md's
// Scope "In" list names "A >=100-repo fixture install exercised end to end" as an in-scope
// deliverable, and Approach step 14 spells out the exact chain — callback -> dispatcher ->
// discovery -> catalog, plus the Redis-loss recovery path and the admin-reconcile sweep path.
// Every existing W7-01 test exercises ONE service against its own mocked/injected dependencies;
// this file is the only one that wires the REAL `handleGithubAppCallback` -> a REAL
// `InstallationDiscoveryDispatcher` instance (`drainOnce()`, not mocked) -> the REAL
// `runInstallationDiscovery` -> the REAL `getRepositoryCatalog`/`reconcileInstallationRepositories`
// against ONE shared in-memory fake store, following exactly the pattern
// `githubInstallationRevokeTraceThrough.test.ts` already established in this same ticket (a fake
// that tracks real state across calls, not a canned per-call mock, is what can actually prove a
// wiring/redelivery/idempotency claim — see that file's own header for the rationale).
//
// Every `@spec` marker below cites an AC/EC id an existing per-service test ALSO covers — this
// file adds wiring/integration proof that the pieces cohere when actually chained together, not
// new specified behavior (see .pipeline/review.md's fix list item 2).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import type { AuthContext } from '../auth/context';
import type { GithubAppClient, InstallationRepoPage, InstalledRepo } from '../github/appClient';
import {
  makeLargeInstallationGithubClient,
  makeLargeInstallationRepos,
} from '../github/__fixtures__/largeInstallation';
import type {
  InstallationSweepOutcome,
  InstallationSyncErrorCode,
  InstallationSyncReason,
} from '../db/githubInstallationSyncStore';
import { INSTALLATION_SYNC_STALL_MS } from '../db/githubInstallationSyncStore';
import { handleGithubAppCallback, type CallbackInput, type InstallCallbackDeps } from './githubAppInstallService';
import { runInstallationDiscovery, type InstallationDiscoveryDeps } from './githubInstallationDiscoveryService';
import { InstallationDiscoveryDispatcher } from './installationDiscoveryDispatcher';
import { reconcileInstallationRepositories, type ReconcileDeps } from './githubInstallationReconcileService';
import { getRepositoryCatalog } from './repositoryCatalogService';

beforeEach(() => {
  setConfigOverrideForTests('GITHUB_WEB_BASE_URL', 'https://github.test');
  setConfigOverrideForTests('GITHUB_APP_SLUG', 'sayre-app');
  setConfigOverrideForTests('GITHUB_POST_INSTALL_REDIRECT_URL', '/settings/integrations');
});

afterEach(() => {
  resetConfigForTests();
});

// ---------------------------------------------------------------------------------------------
// Shared in-memory fake store — one shared JS Map per test scenario stands in for both the
// tenant-scoped `github_installation_sync` store (db/githubInstallationSyncStore.ts) AND the
// cross-tenant dispatcher/outbox boundary (db/githubInstallationDiscoveryOutbox.ts), which in the
// real schema are the same table's disjoint column groups. Every function below is a faithful,
// if simplified, mirror of that file's real CAS/heartbeat/lease semantics (compared line by line
// against services/core/src/db/githubInstallationSyncStore.ts and
// services/core/src/db/githubInstallationDiscoveryOutbox.ts while authoring this), NOT a canned
// per-call mock — that fidelity is what lets this file actually prove resume-without-duplication
// and sweep-coverage claims rather than merely asserting call counts.
// ---------------------------------------------------------------------------------------------

interface FakeSyncRow {
  id: string;
  orgId: string;
  installationId: number;
  runId: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  reason: InstallationSyncReason;
  nextPage: number;
  totalCount: number | null;
  discoveredCount: number;
  registeredCount: number;
  enqueuedCount: number;
  revokedCount: number;
  sweepOutcome: InstallationSweepOutcome;
  attemptCount: number;
  lastErrorCode: InstallationSyncErrorCode | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  completedRunId: string | null;
  dispatch: {
    leaseToken: string | null;
    dispatchAttemptCount: number;
    dueAt: Date;
  };
}

function makeFakeSyncStore() {
  const rows = new Map<string, FakeSyncRow>();
  let runCounter = 0;
  let leaseCounter = 0;

  const key = (orgId: string, installationId: number) => `${orgId}|${installationId}`;
  const requireRow = (orgId: string, installationId: number): FakeSyncRow => {
    const row = rows.get(key(orgId, installationId));
    if (!row) throw new Error(`fake sync row not found for ${key(orgId, installationId)}`);
    return row;
  };

  return {
    rows,

    // ---- tenant-scoped store surface (githubInstallationSyncStore.ts shape) ----
    startInstallationSync: async (
      _tx: unknown,
      row: { orgId: string; installationId: number; reason: InstallationSyncReason; requestedBy: unknown },
    ): Promise<{ reset: boolean; runId: string }> => {
      const now = new Date();
      const k = key(row.orgId, row.installationId);
      const existing = rows.get(k);
      if (
        existing &&
        existing.status === 'running' &&
        now.getTime() - existing.updatedAt.getTime() <= INSTALLATION_SYNC_STALL_MS
      ) {
        return { reset: false, runId: existing.runId };
      }
      runCounter += 1;
      const runId = `run-${k}-${runCounter}`;
      rows.set(k, {
        id: existing?.id ?? `outbox-${k}`,
        orgId: row.orgId,
        installationId: row.installationId,
        runId,
        status: 'pending',
        reason: row.reason,
        nextPage: 1,
        totalCount: null,
        discoveredCount: 0,
        registeredCount: 0,
        enqueuedCount: 0,
        revokedCount: 0,
        sweepOutcome: 'not_applicable',
        attemptCount: 0,
        lastErrorCode: null,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        completedRunId: existing?.completedRunId ?? null,
        // Immediately due — the callback/reconcile's own `kickDiscoveryDispatcher()` is only a
        // latency optimization (OQ-3); the durable due predicate is what actually makes a fresh
        // row claimable, exactly as production's `next_attempt_at = now()` does.
        dispatch: { leaseToken: null, dispatchAttemptCount: 0, dueAt: now },
      });
      return { reset: true, runId };
    },

    claimInstallationSync: async (
      _tx: unknown,
      k2: { orgId: string; installationId: number; expectedRunId: string },
    ): Promise<{ nextPage: number; runId: string; startedAt: Date; reason: InstallationSyncReason } | null> => {
      const row = rows.get(key(k2.orgId, k2.installationId));
      if (!row) return null;
      if (row.runId !== k2.expectedRunId) return null;
      if (row.status !== 'pending' && row.status !== 'failed' && row.status !== 'running') return null;
      row.status = 'running';
      row.attemptCount += 1;
      row.updatedAt = new Date();
      // FND-cf76b24c5057: `reason` is re-read from THIS row (set once at startInstallationSync
      // time and never touched by claim) — the same worker-side-row-read shape production's
      // claimInstallationSync now returns, which is what runInstallationDiscovery's sweep gate
      // actually authorizes against.
      return { nextPage: row.nextPage, runId: row.runId, startedAt: row.startedAt, reason: row.reason };
    },

    advanceInstallationSyncPage: async (
      _tx: unknown,
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
    ): Promise<boolean> => {
      const row = rows.get(key(input.orgId, input.installationId));
      if (!row) return false;
      if (row.runId !== input.runId || row.nextPage !== input.expectedPage || row.status !== 'running') {
        return false;
      }
      row.nextPage = input.expectedPage + 1;
      row.totalCount = input.totalCount;
      row.discoveredCount += input.discoveredDelta;
      row.registeredCount += input.registeredDelta;
      row.enqueuedCount += input.enqueuedDelta;
      row.updatedAt = new Date();
      return true;
    },

    completeInstallationSync: async (
      _tx: unknown,
      k3: { orgId: string; installationId: number; runId: string },
    ): Promise<void> => {
      const row = requireRow(k3.orgId, k3.installationId);
      row.status = 'complete';
      row.completedAt = new Date();
      row.completedRunId = k3.runId;
      row.updatedAt = new Date();
    },

    failInstallationSync: async (input: {
      orgId: string;
      installationId: number;
      runId: string;
      errorCode: InstallationSyncErrorCode;
    }): Promise<void> => {
      const row = requireRow(input.orgId, input.installationId);
      row.status = 'failed';
      row.lastErrorCode = input.errorCode;
      row.updatedAt = new Date();
    },

    cancelInstallationSync: async (input: {
      orgId: string;
      installationId: number;
      runId: string;
    }): Promise<void> => {
      const row = requireRow(input.orgId, input.installationId);
      row.status = 'cancelled';
      row.updatedAt = new Date();
    },

    recordSweepOutcome: async (input: {
      orgId: string;
      installationId: number;
      runId: string;
      outcome: InstallationSweepOutcome;
      revokedCount: number;
    }): Promise<void> => {
      const row = requireRow(input.orgId, input.installationId);
      row.sweepOutcome = input.outcome;
      row.revokedCount = input.revokedCount;
      row.updatedAt = new Date();
    },

    listInstallationSyncRows: async (_tx: unknown, orgId: string) =>
      Array.from(rows.values())
        .filter((row) => row.orgId === orgId)
        .map((row) => ({ ...row })),

    // ---- cross-tenant outbox surface (githubInstallationDiscoveryOutbox.ts shape) ----
    claimOutbox: async (batchSize: number) => {
      const now = new Date();
      const due = Array.from(rows.values())
        .filter((row) => {
          if (row.dispatch.leaseToken !== null) return false;
          if (row.dispatch.dueAt.getTime() > now.getTime()) return false;
          // EC-28: terminal rows are never claimed.
          if (row.status === 'complete' || row.status === 'cancelled') return false;
          if (row.status === 'failed' && row.lastErrorCode === 'page_limit_exceeded') return false;
          return true;
        })
        .slice(0, batchSize);
      return due.map((row) => {
        leaseCounter += 1;
        const leaseToken = `lease-${leaseCounter}`;
        row.dispatch.leaseToken = leaseToken;
        return {
          id: row.id,
          leaseToken,
          orgId: row.orgId,
          installationId: row.installationId,
          runId: row.runId,
          reason: row.reason,
          dispatchAttemptCount: row.dispatch.dispatchAttemptCount,
        };
      });
    },

    completeOutbox: async (id: string, leaseToken: string): Promise<boolean> => {
      const row = Array.from(rows.values()).find((candidate) => candidate.id === id);
      if (!row || row.dispatch.leaseToken !== leaseToken) return false;
      row.dispatch.leaseToken = null;
      row.dispatch.dispatchAttemptCount += 1;
      // Watchdog re-arm (AC-20/AC-23): a real deployment pushes this minutes into the future.
      // This fake's tests drive "a later drainOnce()" explicitly rather than waiting on a real
      // clock, so re-arming to "now" (immediately due again on the next explicit drainOnce()
      // call) is a deliberate simplification, not a behavioral claim about timing.
      row.dispatch.dueAt = new Date();
      return true;
    },

    retryOutbox: async (id: string, leaseToken: string): Promise<boolean> => {
      const row = Array.from(rows.values()).find((candidate) => candidate.id === id);
      if (!row || row.dispatch.leaseToken !== leaseToken) return false;
      row.dispatch.leaseToken = null;
      row.dispatch.dispatchAttemptCount += 1;
      // AC-21: "row stays claimable" — same simplification as completeOutbox above.
      row.dispatch.dueAt = new Date();
      return true;
    },
  };
}

interface FakeRepoRow {
  id: string;
  orgId: string;
  externalId: string;
  fullName: string;
  defaultBranch: string | null;
  revokedAt: Date | null;
  lastDiscoveryRunId: string | null;
  updatedAt: Date;
}

function makeFakeRepositoriesStore() {
  const repos = new Map<string, FakeRepoRow>();
  const outbox = new Map<string, unknown>();
  const installations = new Map<number, { orgId: string; active: boolean }>();
  let nextRepoId = 1;

  const key = (orgId: string, externalId: string) => `${orgId}|github|${externalId}`;

  return {
    repos,
    outbox,
    installations,

    registerRepository: async (
      _tx: unknown,
      row: {
        orgId: string;
        providerRepoId: string;
        fullName: string;
        defaultBranch: string | null;
        discoveryRunId?: string;
      },
    ): Promise<{ repoId: string }> => {
      const k = key(row.orgId, row.providerRepoId);
      const existing = repos.get(k);
      if (existing) {
        existing.fullName = row.fullName;
        existing.defaultBranch = row.defaultBranch;
        existing.revokedAt = null; // re-activation on conflict (EC-19/EC-37)
        existing.lastDiscoveryRunId = row.discoveryRunId ?? existing.lastDiscoveryRunId;
        existing.updatedAt = new Date();
        return { repoId: existing.id };
      }
      const id = `repo-uuid-${nextRepoId++}`;
      repos.set(k, {
        id,
        orgId: row.orgId,
        externalId: row.providerRepoId,
        fullName: row.fullName,
        defaultBranch: row.defaultBranch,
        revokedAt: null,
        lastDiscoveryRunId: row.discoveryRunId ?? null,
        updatedAt: new Date(),
      });
      return { repoId: id };
    },

    markRepositoryRevoked: async (
      _tx: unknown,
      row: { orgId: string; providerRepoId: string },
    ): Promise<boolean> => {
      const existing = repos.get(key(row.orgId, row.providerRepoId));
      if (!existing) return false;
      existing.revokedAt = existing.revokedAt ?? new Date(); // COALESCE-idempotent (EC-36)
      existing.updatedAt = new Date();
      return true;
    },

    enqueueInitialParse: async (
      _tx: unknown,
      envelope: { org_id: string; idempotency_key: string },
    ): Promise<void> => {
      const k = `${envelope.org_id}|${envelope.idempotency_key}`;
      if (!outbox.has(k)) outbox.set(k, envelope);
    },

    listRevokeSweepCandidates: async (
      _tx: unknown,
      input: { orgId: string; observedRunIds: string[]; runStartedAt: Date },
    ): Promise<Array<{ id: string; externalId: string }>> =>
      Array.from(repos.values())
        .filter(
          (row) =>
            row.orgId === input.orgId &&
            row.revokedAt === null &&
            row.updatedAt.getTime() < input.runStartedAt.getTime() &&
            (row.lastDiscoveryRunId === null || !input.observedRunIds.includes(row.lastDiscoveryRunId)),
        )
        .map((row) => ({ id: row.id, externalId: row.externalId })),

    countActiveGithubRepositories: async (_tx: unknown, orgId: string): Promise<number> =>
      Array.from(repos.values()).filter((row) => row.orgId === orgId && row.revokedAt === null).length,

    listActiveInstallationsForOrg: async (
      _tx: unknown,
      orgId: string,
    ): Promise<Array<{ installationId: number }>> =>
      Array.from(installations.entries())
        .filter(([, value]) => value.orgId === orgId && value.active)
        .map(([installationId]) => ({ installationId })),

    resolveInstallationOrg: async (installationId: number): Promise<{ orgId: string; active: boolean } | null> =>
      installations.get(installationId) ?? null,

    upsertInstallation: async (
      _tx: unknown,
      row: { orgId: string; installationId: number },
    ): Promise<void> => {
      installations.set(row.installationId, { orgId: row.orgId, active: true });
    },
  };
}

/** Wraps a fixture GithubAppClient so a test can inject a one-shot failure on a specific page,
 *  and always records every page number requested (for "no re-fetch of a committed page"
 *  assertions). */
function trackedGithubClient(
  base: GithubAppClient,
): GithubAppClient & { calls: number[]; failPageOnce: (page: number) => void } {
  const calls: number[] = [];
  const failOnce = new Set<number>();
  return {
    ...base,
    calls,
    failPageOnce: (page: number) => failOnce.add(page),
    listInstallationReposPage: async (
      installationId: number,
      page: number,
      perPage?: number,
    ): Promise<InstallationRepoPage> => {
      calls.push(page);
      if (failOnce.has(page)) {
        failOnce.delete(page);
        throw new Error(`simulated GitHub failure on page ${page}`);
      }
      return base.listInstallationReposPage(installationId, page, perPage);
    },
  };
}

function buildDiscoveryDeps(
  syncStore: ReturnType<typeof makeFakeSyncStore>,
  repoStore: ReturnType<typeof makeFakeRepositoriesStore>,
  githubClient: GithubAppClient,
): Partial<InstallationDiscoveryDeps> {
  return {
    resolveInstallationOrg: repoStore.resolveInstallationOrg,
    githubClient,
    withOrg: async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    claimInstallationSync: syncStore.claimInstallationSync as unknown as InstallationDiscoveryDeps['claimInstallationSync'],
    advanceInstallationSyncPage:
      syncStore.advanceInstallationSyncPage as unknown as InstallationDiscoveryDeps['advanceInstallationSyncPage'],
    completeInstallationSync:
      syncStore.completeInstallationSync as unknown as InstallationDiscoveryDeps['completeInstallationSync'],
    failInstallationSync: syncStore.failInstallationSync,
    cancelInstallationSync: syncStore.cancelInstallationSync,
    recordSweepOutcome: syncStore.recordSweepOutcome,
    registerRepository: repoStore.registerRepository as unknown as InstallationDiscoveryDeps['registerRepository'],
    enqueueInitialParse: repoStore.enqueueInitialParse,
    kickInitialParseOutbox: vi.fn(),
    listActiveInstallationsForOrg:
      repoStore.listActiveInstallationsForOrg as unknown as InstallationDiscoveryDeps['listActiveInstallationsForOrg'],
    listInstallationSyncRows:
      syncStore.listInstallationSyncRows as unknown as InstallationDiscoveryDeps['listInstallationSyncRows'],
    listRevokeSweepCandidates: repoStore.listRevokeSweepCandidates,
    countActiveGithubRepositories: repoStore.countActiveGithubRepositories,
    markRepositoryRevoked: repoStore.markRepositoryRevoked,
  };
}

function authorizedCallback(overrides: CallbackInput = {}): CallbackInput {
  return { state: 'x', installationId: '555', code: 'one-time-oauth-code', ...overrides };
}

const ADMIN = (orgId: string): AuthContext => ({
  subjectType: 'user',
  userId: 'admin-1',
  orgId,
  roles: ['admin'],
});

describe('W7-01 end-to-end — callback -> dispatcher -> discovery -> catalog', () => {
  // @spec AC-4 AC-5 AC-6 AC-8 AC-9
  it('a >=100-repo (120) fixture install completes end to end: catalog sync.status moves importing -> idle and sync.registeredRepositories matches the fixture count', async () => {
    const ORG = 'e2e-org-a';
    const INSTALLATION_ID = 9001;
    const syncStore = makeFakeSyncStore();
    const repoStore = makeFakeRepositoriesStore();
    const githubClient = trackedGithubClient(
      makeLargeInstallationGithubClient({ idPrefix: 'e2e-a' }),
    );

    const callbackDeps: Partial<InstallCallbackDeps> = {
      verifyState: async () => ({ org_id: ORG, nonce: 'n', purpose: 'github_app_install' }),
      resolveExistingInstallationOrg: async () => null,
      githubClient,
      withOrg: async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
      getDb: async () => ({}) as never,
      upsertInstallation: repoStore.upsertInstallation,
      startInstallationSync: syncStore.startInstallationSync as unknown as InstallCallbackDeps['startInstallationSync'],
      kickDiscoveryDispatcher: vi.fn(),
    };

    const callbackResult = await handleGithubAppCallback(
      authorizedCallback({ installationId: String(INSTALLATION_ID) }),
      callbackDeps,
    );
    expect(callbackResult).toEqual({ redirectTo: '/settings/integrations', discovery: 'queued' });

    // AC-1: the request path itself performed no repo listing at all.
    expect(githubClient.calls).toEqual([]);

    // Before the worker has run, the catalog already reads the pending row as "importing".
    const beforeCatalog = await getRepositoryCatalog(ADMIN(ORG), {
      store: { list: async () => [] },
      permissions: { getReadScope: async () => ({ allows: [], denies: [] }) },
      syncRows: async (orgId: string) => syncStore.listInstallationSyncRows({}, orgId),
      now: () => new Date(),
    });
    expect(beforeCatalog.sync.status).toBe('importing');

    const dispatcher = new InstallationDiscoveryDispatcher({
      claim: syncStore.claimOutbox,
      complete: syncStore.completeOutbox,
      retry: syncStore.retryOutbox,
      publish: async (envelope) => {
        const result = await runInstallationDiscovery(
          envelope,
          buildDiscoveryDeps(syncStore, repoStore, githubClient),
        );
        expect(result.status).toBe('complete');
        return 'fake-bullmq-job-id';
      },
      reportError: vi.fn(),
    });

    const drainResult = await dispatcher.drainOnce();
    expect(drainResult).toEqual({ claimed: 1, dispatched: 1, deferred: 0 });

    // AC-4: exactly 2 page requests for 120 repos (page 1 full at 100, page 2 with 20).
    expect(githubClient.calls).toEqual([1, 2]);

    const afterCatalog = await getRepositoryCatalog(ADMIN(ORG), {
      store: { list: async () => [] },
      permissions: { getReadScope: async () => ({ allows: [], denies: [] }) },
      syncRows: async (orgId: string) => syncStore.listInstallationSyncRows({}, orgId),
      now: () => new Date(),
    });
    expect(afterCatalog.sync.status).toBe('idle');
    expect(afterCatalog.sync.registeredRepositories).toBe(120);
    expect(afterCatalog.sync.discoveredRepositories).toBe(120);
    // Two "empty" repos (no default branch/HEAD) in the fixture are registered but not enqueued.
    expect(repoStore.outbox.size).toBe(118);
    expect(repoStore.repos.size).toBe(120);
  });
});

describe('W7-01 end-to-end — Redis-loss recovery: dispatcher publish fails mid-run, a later drainOnce() resumes without re-fetching committed pages', () => {
  // @spec AC-20 AC-21 EC-9 EC-24
  it('page 1 commits, publish fails partway through page 2, and a later drainOnce() + resumed runInstallationDiscovery finishes without re-fetching page 1 or double-registering repositories', async () => {
    const ORG = 'e2e-org-b';
    const INSTALLATION_ID = 9002;
    const syncStore = makeFakeSyncStore();
    const repoStore = makeFakeRepositoriesStore();
    const githubClient = trackedGithubClient(
      makeLargeInstallationGithubClient({ idPrefix: 'e2e-b' }),
    );
    // Simulate the job disappearing between pages: page 2's fetch fails exactly once.
    githubClient.failPageOnce(2);

    const callbackDeps: Partial<InstallCallbackDeps> = {
      verifyState: async () => ({ org_id: ORG, nonce: 'n', purpose: 'github_app_install' }),
      resolveExistingInstallationOrg: async () => null,
      githubClient,
      withOrg: async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
      getDb: async () => ({}) as never,
      upsertInstallation: repoStore.upsertInstallation,
      startInstallationSync: syncStore.startInstallationSync as unknown as InstallCallbackDeps['startInstallationSync'],
      kickDiscoveryDispatcher: vi.fn(),
    };

    await handleGithubAppCallback(authorizedCallback({ installationId: String(INSTALLATION_ID) }), callbackDeps);

    const reportError = vi.fn();
    const dispatcher = new InstallationDiscoveryDispatcher({
      claim: syncStore.claimOutbox,
      complete: syncStore.completeOutbox,
      retry: syncStore.retryOutbox,
      // The dispatcher's own `publish` directly drives the worker in this in-process wiring
      // test (see file header) — so a worker-side failure surfaces to the dispatcher exactly as
      // "the dispatcher's publish failed", which is what AC-21/EC-9's "publish() fails" recovery
      // path is written against.
      publish: async (envelope) =>
        runInstallationDiscovery(envelope, buildDiscoveryDeps(syncStore, repoStore, githubClient)).then(
          () => 'fake-bullmq-job-id',
        ),
      reportError,
    });

    // First cycle: page 1 commits for real (100 repos registered), then page 2's fetch throws,
    // runInstallationDiscovery marks the row failed(provider_unavailable) and rethrows, which
    // this test's `publish` propagates — the dispatcher treats it as a failed publish.
    const firstDrain = await dispatcher.drainOnce();
    expect(firstDrain).toEqual({ claimed: 1, dispatched: 0, deferred: 1 });
    expect(reportError).toHaveBeenCalledWith('publish');

    const rowAfterFirstDrain = syncStore.rows.get(`${ORG}|${INSTALLATION_ID}`);
    expect(rowAfterFirstDrain?.status).toBe('failed');
    expect(rowAfterFirstDrain?.lastErrorCode).toBe('provider_unavailable');
    expect(rowAfterFirstDrain?.nextPage).toBe(2); // page 1 already committed
    expect(repoStore.repos.size).toBe(100); // only page 1's repos landed
    expect(githubClient.calls).toEqual([1, 2]);

    // AC-21/EC-9: the row stays claimable (retry() released the lease with the row still due) —
    // no manual reconcile required.
    const secondDrain = await dispatcher.drainOnce();
    expect(secondDrain).toEqual({ claimed: 1, dispatched: 1, deferred: 0 });

    // Resumed at page 2 — page 1 was NEVER re-fetched.
    expect(githubClient.calls).toEqual([1, 2, 2]);

    const rowAfterSecondDrain = syncStore.rows.get(`${ORG}|${INSTALLATION_ID}`);
    expect(rowAfterSecondDrain?.status).toBe('complete');
    expect(rowAfterSecondDrain?.registeredCount).toBe(120);

    // No duplicate repository rows — 120, not 220.
    expect(repoStore.repos.size).toBe(120);
    const catalog = await getRepositoryCatalog(ADMIN(ORG), {
      store: { list: async () => [] },
      permissions: { getReadScope: async () => ({ allows: [], denies: [] }) },
      syncRows: async (orgId: string) => syncStore.listInstallationSyncRows({}, orgId),
      now: () => new Date(),
    });
    expect(catalog.sync.status).toBe('idle');
    expect(catalog.sync.registeredRepositories).toBe(120);
  });
});

describe('W7-01 end-to-end — admin-reconcile sweep: drop one repo from the fixture, reconcile, only that repo is revoked', () => {
  // @spec AC-10 AC-24 AC-25 AC-26 AC-27 EC-34 EC-38
  it('a manual_reconcile run chained end to end revokes exactly the one repository GitHub no longer reports, leaving the other 119 untouched', async () => {
    const ORG = 'e2e-org-c';
    const INSTALLATION_ID = 9003;
    const syncStore = makeFakeSyncStore();
    const repoStore = makeFakeRepositoriesStore();
    const fullRepos = makeLargeInstallationRepos({ idPrefix: 'e2e-c' });
    const droppedRepo = fullRepos.find((repo) => repo.default_branch !== null) as InstalledRepo;
    const droppedFullName = droppedRepo.full_name;

    const initialGithubClient = trackedGithubClient(
      makeLargeInstallationGithubClient({ idPrefix: 'e2e-c' }),
    );

    // 1. Establish full coverage: a normal app_install run observes and registers all 120 repos.
    const callbackDeps: Partial<InstallCallbackDeps> = {
      verifyState: async () => ({ org_id: ORG, nonce: 'n', purpose: 'github_app_install' }),
      resolveExistingInstallationOrg: async () => null,
      githubClient: initialGithubClient,
      withOrg: async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
      getDb: async () => ({}) as never,
      upsertInstallation: repoStore.upsertInstallation,
      startInstallationSync: syncStore.startInstallationSync as unknown as InstallCallbackDeps['startInstallationSync'],
      kickDiscoveryDispatcher: vi.fn(),
    };
    await handleGithubAppCallback(authorizedCallback({ installationId: String(INSTALLATION_ID) }), callbackDeps);

    const initialDispatcher = new InstallationDiscoveryDispatcher({
      claim: syncStore.claimOutbox,
      complete: syncStore.completeOutbox,
      retry: syncStore.retryOutbox,
      publish: async (envelope) =>
        runInstallationDiscovery(
          envelope,
          buildDiscoveryDeps(syncStore, repoStore, initialGithubClient),
        ).then(() => 'job-1'),
      reportError: vi.fn(),
    });
    const firstDrain = await initialDispatcher.drainOnce();
    expect(firstDrain).toEqual({ claimed: 1, dispatched: 1, deferred: 0 });
    expect(repoStore.repos.size).toBe(120);
    await expect(repoStore.countActiveGithubRepositories({}, ORG)).resolves.toBe(120);

    // A repository row's updatedAt must precede the reconcile run's startedAt for it to be
    // eligible as a sweep candidate at all (EC-34) — advance the clock past the first run.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 2. GitHub now reports one fewer repository than before (access to `droppedFullName` was
    // removed) — the reconcile run's own fetch omits it entirely.
    const reconcileGithubClient = trackedGithubClient({
      ...initialGithubClient,
      listInstallationReposPage: async (installationId: number, page: number, perPage?: number) => {
        const size = perPage ?? 100;
        const remaining = fullRepos.filter((repo) => repo.full_name !== droppedFullName);
        const start = (page - 1) * size;
        const pageRepos = remaining.slice(start, start + size);
        return {
          repos: pageRepos,
          page,
          hasNextPage: pageRepos.length === size,
          totalCount: remaining.length,
        };
      },
    });

    const reconcileDeps: Partial<ReconcileDeps> = {
      resolveActiveInstallations: async (orgId: string) => repoStore.listActiveInstallationsForOrg({}, orgId),
      withOrg: async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
      startInstallationSync: syncStore.startInstallationSync as unknown as ReconcileDeps['startInstallationSync'],
      kickDiscoveryDispatcher: vi.fn(),
    };
    const reconcileResult = await reconcileInstallationRepositories(ADMIN(ORG), reconcileDeps);
    expect(reconcileResult).toEqual({ status: 'queued', installations: 1, queued: 1 });

    const reconcileDispatcher = new InstallationDiscoveryDispatcher({
      claim: syncStore.claimOutbox,
      complete: syncStore.completeOutbox,
      retry: syncStore.retryOutbox,
      publish: async (envelope) =>
        runInstallationDiscovery(
          envelope,
          buildDiscoveryDeps(syncStore, repoStore, reconcileGithubClient),
        ).then(() => 'job-2'),
      reportError: vi.fn(),
    });
    const secondDrain = await reconcileDispatcher.drainOnce();
    expect(secondDrain).toEqual({ claimed: 1, dispatched: 1, deferred: 0 });

    // AC-24/AC-26: exactly the dropped repo is revoked; sweep applied with revoked count 1.
    const droppedRow = Array.from(repoStore.repos.values()).find((row) => row.fullName === droppedFullName);
    expect(droppedRow?.revokedAt).toBeInstanceOf(Date);
    const stillActive = Array.from(repoStore.repos.values()).filter(
      (row) => row.fullName !== droppedFullName,
    );
    expect(stillActive).toHaveLength(119);
    expect(stillActive.every((row) => row.revokedAt === null)).toBe(true);

    const finalRow = syncStore.rows.get(`${ORG}|${INSTALLATION_ID}`);
    expect(finalRow?.sweepOutcome).toBe('applied');
    expect(finalRow?.revokedCount).toBe(1);

    // AC-26: an admin reads the outcome back through the catalog.
    const catalog = await getRepositoryCatalog(ADMIN(ORG), {
      store: { list: async () => [] },
      permissions: { getReadScope: async () => ({ allows: [], denies: [] }) },
      syncRows: async (orgId: string) => syncStore.listInstallationSyncRows({}, orgId),
      now: () => new Date(),
    });
    expect(catalog.sync.sweepOutcome).toBe('applied');
    expect(catalog.sync.revokedRepositories).toBe(1);
  });
});

// Tester-style trace-through coverage (W7-01), authored by `red` per spec.md's own "Created
// files" list — the replacement for W2-09's "additive-only" structural guarantee now that the
// destructive sweep direction exists. Wires the REAL service functions
// (`applyInstallationRepositoriesEvent`, `runInstallationDiscovery`) against ONE shared in-memory
// fake "repositories" table, following the exact pattern
// githubInstallationRepositoriesTraceThrough.test.ts already established for this codebase (see
// that file's header for the rationale: a fake that tracks real state across calls, not a canned
// per-call mock, is what can actually prove a redelivery/idempotency/reversibility claim).
//
// `githubInstallationDiscoveryService.ts` does not exist yet, so every test that imports it fails
// today at module resolution (RED-CORRECT).

import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InstalledRepo } from '../github/appClient';
import { makeEnvelope } from '../queue/envelope';

const SHA_A = 'a'.repeat(40);
const ORG = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const INSTALLATION_ID = 555;

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

/** Same shape as githubInstallationRepositoriesTraceThrough.test.ts's makeFakeStore, extended
 *  with the W7-01 sweep-marker columns (last_discovery_run_id / last_discovery_at). */
function makeFakeStore() {
  const repos = new Map<string, FakeRepoRow>();
  const outbox = new Map<string, unknown>();
  let nextId = 1;

  function key(orgId: string, externalId: string): string {
    return `${orgId}|github|${externalId}`;
  }

  return {
    repos,
    outbox,
    registerRepository: vi.fn(
      async (
        _tx: unknown,
        row: { orgId: string; providerRepoId: string; fullName: string; defaultBranch: string | null; discoveryRunId?: string },
      ): Promise<{ repoId: string }> => {
        const k = key(row.orgId, row.providerRepoId);
        const existing = repos.get(k);
        if (existing) {
          existing.fullName = row.fullName;
          existing.defaultBranch = row.defaultBranch;
          existing.revokedAt = null; // re-activation on conflict
          existing.lastDiscoveryRunId = row.discoveryRunId ?? existing.lastDiscoveryRunId;
          existing.updatedAt = new Date();
          return { repoId: existing.id };
        }
        const id = `repo-uuid-${nextId++}`;
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
    ),
    markRepositoryRevoked: vi.fn(async (_tx: unknown, row: { orgId: string; providerRepoId: string }): Promise<boolean> => {
      const existing = repos.get(key(row.orgId, row.providerRepoId));
      if (!existing) return false;
      existing.revokedAt = existing.revokedAt ?? new Date(); // COALESCE-idempotent
      existing.updatedAt = new Date();
      return true;
    }),
    enqueueInitialParse: vi.fn(async (_tx: unknown, envelope: { org_id: string; idempotency_key: string }) => {
      const k = `${envelope.org_id}|${envelope.idempotency_key}`;
      if (!outbox.has(k)) outbox.set(k, envelope);
    }),
    listActiveGithubRepos: (orgId: string) =>
      Array.from(repos.values()).filter((r) => r.orgId === orgId && r.revokedAt === null),
  };
}

function makeInstalledRepo(overrides: Partial<InstalledRepo> = {}): InstalledRepo {
  return {
    provider_repo_id: '111',
    full_name: 'acme/widgets',
    default_branch: 'main',
    default_branch_head_sha: SHA_A,
    ...overrides,
  };
}

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'services/core/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

function readSource(relative: string): string {
  return readFileSync(resolve(repositoryRoot(), relative), 'utf8');
}

describe('AC-29 — exactly two revoke call sites, structurally enumerable', () => {
  // @spec AC-29
  it('markRepositoryRevoked is called from exactly two service files: the removed webhook and the discovery sweep', () => {
    const candidateFiles = [
      'services/core/src/services/githubInstallationRepositoriesService.ts', // applyRemoved (webhook)
      'services/core/src/services/githubInstallationDiscoveryService.ts', // the new discovery sweep
      'services/core/src/services/githubInstallationReconcileService.ts', // request path — must NOT call it
      'services/core/src/services/githubAppInstallService.ts', // request path — must NOT call it
    ];
    const callSites = candidateFiles.filter((file) => {
      const path = resolve(repositoryRoot(), file);
      if (!existsSync(path)) return false; // githubInstallationDiscoveryService.ts doesn't exist yet
      return /\bmarkRepositoryRevoked\(/.test(readSource(file));
    });
    expect(callSites.sort()).toEqual(
      [
        'services/core/src/services/githubInstallationDiscoveryService.ts',
        'services/core/src/services/githubInstallationRepositoriesService.ts',
      ].sort(),
    );
  });
});

describe('AC-28/EC-37 — reversibility: a swept repository comes back automatically', () => {
  // @spec AC-28 EC-37
  it('a repo revoked by the sweep and later reported again by discovery is re-activated with the current run marker and re-enqueued', async () => {
    const store = makeFakeStore();
    // Seed a repo already revoked by an earlier sweep.
    await store.registerRepository({}, { orgId: ORG, providerRepoId: '999', fullName: 'acme/came-back', defaultBranch: 'main', discoveryRunId: 'old-run' });
    await store.markRepositoryRevoked({}, { orgId: ORG, providerRepoId: '999' });
    expect(store.repos.get(`${ORG}|github|999`)?.revokedAt).toBeInstanceOf(Date);

    const { runInstallationDiscovery } = await import('./githubInstallationDiscoveryService');
    const envelope = makeEnvelope({
      org_id: ORG,
      type: 'github.installation_discovery',
      source: 'github-app-install',
      payload: { provider: 'github', type: 'installation_discovery', installation_id: String(INSTALLATION_ID), run_id: RUN_ID, reason: 'app_install' },
    });
    const githubClient = {
      authorizeInstallation: vi.fn(),
      mintInstallationToken: vi.fn(),
      getInstallationRepo: vi.fn(),
      listInstallationReposPage: vi.fn(async () => ({
        repos: [makeInstalledRepo({ provider_repo_id: '999', full_name: 'acme/came-back' })],
        page: 1,
        hasNextPage: false,
        totalCount: 1,
      })),
    };
    const deps = {
      resolveInstallationOrg: vi.fn(async () => ({ orgId: ORG, active: true })),
      githubClient,
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
      // FND-cf76b24c5057: the sweep's authorization now reads THIS (claimInstallationSync's
      // worker-side row read), never envelope.payload.reason — the row's own reason genuinely is
      // 'app_install' here, matching the envelope.
      claimInstallationSync: vi.fn(async () => ({ nextPage: 1, runId: RUN_ID, startedAt: new Date(), reason: 'app_install' as const })),
      advanceInstallationSyncPage: vi.fn(async () => true),
      completeInstallationSync: vi.fn(async () => undefined),
      failInstallationSync: vi.fn(async () => undefined),
      cancelInstallationSync: vi.fn(async () => undefined),
      recordSweepOutcome: vi.fn(async () => undefined),
      registerRepository: store.registerRepository,
      enqueueInitialParse: store.enqueueInitialParse,
      kickInitialParseOutbox: vi.fn(),
      listActiveInstallationsForOrg: vi.fn(async () => [{ installationId: INSTALLATION_ID }]),
      listInstallationSyncRows: vi.fn(async () => [{ installationId: INSTALLATION_ID, completedRunId: RUN_ID }]),
      listRevokeSweepCandidates: vi.fn(async () => []),
      countActiveGithubRepositories: vi.fn(async () => 0),
      markRepositoryRevoked: store.markRepositoryRevoked,
    };

    await runInstallationDiscovery(envelope as never, deps as never);

    const row = store.repos.get(`${ORG}|github|999`);
    expect(row?.revokedAt).toBeNull(); // re-activated
    expect(row?.lastDiscoveryRunId).toBe(RUN_ID); // marker restamped to the current run
    expect(store.outbox.size).toBe(1); // re-enqueued for parse (has default branch + HEAD)
  });
});

describe('EC-36 — an already-revoked candidate is never double-counted or re-timestamped', () => {
  // @spec EC-36
  it('running the real sweep twice against a candidate already revoked by the first pass leaves revoked_at fixed and does not inflate revoked_count on the second pass', async () => {
    const store = makeFakeStore();
    await store.registerRepository({}, { orgId: ORG, providerRepoId: '111', fullName: 'acme/widgets', defaultBranch: 'main' });

    const { runInstallationDiscovery } = await import('./githubInstallationDiscoveryService');
    const runOnce = async (runId: string) => {
      const envelope = makeEnvelope({
        org_id: ORG,
        type: 'github.installation_discovery',
        source: 'github-reconcile',
        payload: { provider: 'github', type: 'installation_discovery', installation_id: String(INSTALLATION_ID), run_id: runId, reason: 'manual_reconcile' },
      });
      const deps = {
        resolveInstallationOrg: vi.fn(async () => ({ orgId: ORG, active: true })),
        githubClient: {
          authorizeInstallation: vi.fn(),
          mintInstallationToken: vi.fn(),
          getInstallationRepo: vi.fn(),
          // A stable, always-reported placeholder repo keeps `discovered` > 0 on every run (so
          // the empty-result guard never fires) without ever being a revoke candidate itself.
          listInstallationReposPage: vi.fn(async () => ({
            repos: [makeInstalledRepo({ provider_repo_id: '222', full_name: 'acme/always-present' })],
            page: 1,
            hasNextPage: false,
            totalCount: 1,
          })),
        },
        withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
        // FND-cf76b24c5057: the row's own reason genuinely is 'manual_reconcile' on every pass
        // of this test — matching the envelope built above — so the sweep gate (now reading this
        // worker-side row read, never envelope.payload.reason) still authorizes both passes.
        claimInstallationSync: vi.fn(async () => ({ nextPage: 1, runId, startedAt: new Date(), reason: 'manual_reconcile' as const })),
        advanceInstallationSyncPage: vi.fn(async () => true),
        completeInstallationSync: vi.fn(async () => undefined),
        failInstallationSync: vi.fn(async () => undefined),
        cancelInstallationSync: vi.fn(async () => undefined),
        recordSweepOutcome: vi.fn(async () => undefined),
        registerRepository: store.registerRepository,
        enqueueInitialParse: store.enqueueInitialParse,
        kickInitialParseOutbox: vi.fn(),
        listActiveInstallationsForOrg: vi.fn(async () => [{ installationId: INSTALLATION_ID }]),
        listInstallationSyncRows: vi.fn(async () => [{ installationId: INSTALLATION_ID, completedRunId: runId }]),
        // The real candidate query only ever selects revoked_at IS NULL rows NOT stamped with
        // this run's own marker — this fake mirrors that filter against the shared store, rather
        // than a canned fixed list, so a second pass genuinely re-derives its candidates from
        // current state (and correctly excludes the placeholder repo above, since it WAS just
        // observed this run).
        listRevokeSweepCandidates: vi.fn(async () =>
          store
            .listActiveGithubRepos(ORG)
            .filter((row) => row.lastDiscoveryRunId !== runId)
            .map((row) => ({ id: row.id, externalId: row.externalId })),
        ),
        countActiveGithubRepositories: vi.fn(async () => store.listActiveGithubRepos(ORG).length),
        markRepositoryRevoked: store.markRepositoryRevoked,
      };
      return runInstallationDiscovery(envelope as never, deps as never);
    };

    const first = await runOnce('run-a');
    const firstRevokedAt = store.repos.get(`${ORG}|github|111`)?.revokedAt;
    expect(firstRevokedAt).toBeInstanceOf(Date);
    expect((first as { sweep: { revoked: number } }).sweep.revoked).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runOnce('run-b');

    // The repo is no longer an active candidate (revoked_at is already set), so the second
    // sweep's own candidate set is empty and its revoked count is 0 — never re-counted.
    expect((second as { sweep: { revoked: number } }).sweep.revoked).toBe(0);
    expect(store.repos.get(`${ORG}|github|111`)?.revokedAt).toBe(firstRevokedAt); // timestamp unchanged
  });
});

describe('EC-38 — revocation is unreachable from any non-admin surface', () => {
  // @spec EC-38
  it('the discovery envelope carries no field that can target or influence a sweep — the sweep candidate set comes only from the server-side query', async () => {
    const { runInstallationDiscovery } = await import('./githubInstallationDiscoveryService');
    const envelope = makeEnvelope({
      org_id: ORG,
      type: 'github.installation_discovery',
      source: 'github-reconcile',
      payload: {
        provider: 'github',
        type: 'installation_discovery',
        installation_id: String(INSTALLATION_ID),
        run_id: RUN_ID,
        reason: 'manual_reconcile',
        // A hostile/tampered extra field attempting to steer which repo gets revoked — must be
        // ignored entirely; the sweep may only act on listRevokeSweepCandidates's own result.
        target_repo_id: 'not-a-real-candidate',
      } as unknown as Record<string, unknown>,
    });
    const listRevokeSweepCandidates = vi.fn(async () => [{ id: 'repo-x', externalId: '999' }]);
    const markRepositoryRevoked = vi.fn(async () => true);
    const deps = {
      resolveInstallationOrg: vi.fn(async () => ({ orgId: ORG, active: true })),
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        getInstallationRepo: vi.fn(),
        // A non-empty page: `discovered` must be > 0 here so the run reaches the candidate/ratio
        // guards this test actually exercises, rather than tripping the UNRELATED
        // withheld_empty_result guard (discovered === 0 while the org holds active repos) before
        // listRevokeSweepCandidates is ever called. (Fixed from an earlier draft that returned an
        // empty page here, which made `countActiveGithubRepositories`'s `1` collide with the
        // empty-result guard and never let this test reach what it actually asserts.)
        listInstallationReposPage: vi.fn(async () => ({
          repos: [makeInstalledRepo({ provider_repo_id: '222', full_name: 'acme/always-present' })],
          page: 1,
          hasNextPage: false,
          totalCount: 1,
        })),
      },
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
      // FND-cf76b24c5057: the row's own reason genuinely is 'manual_reconcile' here too, matching
      // the envelope — the sweep gate reads THIS (claimInstallationSync's worker-side row read),
      // never envelope.payload.reason.
      claimInstallationSync: vi.fn(async () => ({ nextPage: 1, runId: RUN_ID, startedAt: new Date(), reason: 'manual_reconcile' as const })),
      advanceInstallationSyncPage: vi.fn(async () => true),
      completeInstallationSync: vi.fn(async () => undefined),
      failInstallationSync: vi.fn(async () => undefined),
      cancelInstallationSync: vi.fn(async () => undefined),
      recordSweepOutcome: vi.fn(async () => undefined),
      registerRepository: vi.fn(async () => ({ repoId: 'repo-uuid' })),
      enqueueInitialParse: vi.fn(async () => undefined),
      kickInitialParseOutbox: vi.fn(),
      listActiveInstallationsForOrg: vi.fn(async () => [{ installationId: INSTALLATION_ID }]),
      listInstallationSyncRows: vi.fn(async () => [{ installationId: INSTALLATION_ID, completedRunId: RUN_ID }]),
      listRevokeSweepCandidates,
      countActiveGithubRepositories: vi.fn(async () => 1),
      markRepositoryRevoked,
    };

    await runInstallationDiscovery(envelope as never, deps as never);

    // The only argument shape listRevokeSweepCandidates ever receives is the server-derived
    // {orgId, observedRunIds, runStartedAt} — never anything sourced from the envelope's payload
    // beyond org_id/installation_id/reason/run_id.
    expect(listRevokeSweepCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ target_repo_id: expect.anything() }),
    );
    // And the revoke that DOES happen targets only the server-returned candidate, not the
    // tampered field.
    expect(markRepositoryRevoked).toHaveBeenCalledWith(expect.anything(), { orgId: ORG, providerRepoId: '999' });
  });
});

describe('EC-38 (FND-cf76b24c5057 regression) — a reason/row MISMATCH never authorizes a sweep', () => {
  // @spec AC-25 EC-38
  it('the queue envelope claims manual_reconcile but the row itself (re-read via claimInstallationSync) is app_install — no sweep, against the real stateful store', async () => {
    const store = makeFakeStore();
    await store.registerRepository({}, { orgId: ORG, providerRepoId: '999', fullName: 'acme/should-not-be-revoked', defaultBranch: 'main' });

    const { runInstallationDiscovery } = await import('./githubInstallationDiscoveryService');
    // A hostile or stale queue payload claims manual_reconcile — the kind of tampered/replayed
    // BullMQ job security's FND-cf76b24c5057 finding hypothesized. The row itself, re-read
    // independently by the worker, is what must actually gate the sweep.
    const envelope = makeEnvelope({
      org_id: ORG,
      type: 'github.installation_discovery',
      source: 'github-reconcile',
      payload: {
        provider: 'github',
        type: 'installation_discovery',
        installation_id: String(INSTALLATION_ID),
        run_id: RUN_ID,
        reason: 'manual_reconcile',
      },
    });
    const listRevokeSweepCandidates = vi.fn(async () => [{ id: 'repo-x', externalId: '999' }]);
    const deps = {
      resolveInstallationOrg: vi.fn(async () => ({ orgId: ORG, active: true })),
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        getInstallationRepo: vi.fn(),
        listInstallationReposPage: vi.fn(async () => ({
          repos: [makeInstalledRepo({ provider_repo_id: '222', full_name: 'acme/always-present' })],
          page: 1,
          hasNextPage: false,
          totalCount: 1,
        })),
      },
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
      // The row's REAL reason — genuinely app_install, disagreeing with the envelope above.
      claimInstallationSync: vi.fn(async () => ({ nextPage: 1, runId: RUN_ID, startedAt: new Date(), reason: 'app_install' as const })),
      advanceInstallationSyncPage: vi.fn(async () => true),
      completeInstallationSync: vi.fn(async () => undefined),
      failInstallationSync: vi.fn(async () => undefined),
      cancelInstallationSync: vi.fn(async () => undefined),
      recordSweepOutcome: vi.fn(async () => undefined),
      registerRepository: store.registerRepository,
      enqueueInitialParse: vi.fn(async () => undefined),
      kickInitialParseOutbox: vi.fn(),
      listActiveInstallationsForOrg: vi.fn(async () => [{ installationId: INSTALLATION_ID }]),
      listInstallationSyncRows: vi.fn(async () => [{ installationId: INSTALLATION_ID, completedRunId: RUN_ID }]),
      listRevokeSweepCandidates,
      countActiveGithubRepositories: vi.fn(async () => 1),
      markRepositoryRevoked: store.markRepositoryRevoked,
    };

    const result = await runInstallationDiscovery(envelope as never, deps as never);

    expect((result as { sweep: { outcome: string; revoked: number } }).sweep).toEqual({
      outcome: 'not_applicable',
      revoked: 0,
    });
    expect(listRevokeSweepCandidates).not.toHaveBeenCalled();
    expect(store.repos.get(`${ORG}|github|999`)?.revokedAt).toBeNull();
  });
});

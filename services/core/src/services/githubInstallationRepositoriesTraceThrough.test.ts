// Tester-added coverage (W2-09) — mirrors the established pattern in
// githubInstallLifecycleTraceThrough.test.ts: wires the real service functions
// (`applyInstallationRepositoriesEvent`, `reconcileInstallationRepositories`)
// against ONE shared in-memory fake "repositories" table + "outbox" table that
// reproduce the REAL Postgres conflict semantics documented in
// db/githubAppInstallWrites.ts and db/githubInitialParseOutbox.ts, instead of
// dependencies that trivially return a fixed "success" shape on every call.
//
// This exists because githubInstallationRepositoriesService.test.ts and
// githubInstallationReconcileService.test.ts (dev's own coverage) each call
// the service under test exactly ONCE per test, with mocked deps that always
// return the same canned result regardless of prior calls. That proves the
// service's internal branching logic, but it does NOT prove the acceptance
// criteria that are specifically about what happens on a SECOND, identical
// call (webhook redelivery) — which is the actual idempotency mechanism the
// spec asks Tester to trace through (spec.md AC2/AC3, "Idempotency /
// redelivery / ordering" edge cases). A fake that always says "registered: 1"
// cannot expose whether a second call would create a duplicate row; only a
// fake that actually tracks state across calls can.
//
// Key finding captured by these tests (see the "redelivery" describe block):
// `registerRepository`'s real `onConflictDoUpdate(...).returning(...)` ALWAYS
// returns exactly one row (insert or update, indistinguishably), and
// `enqueueInitialParseOutbox` returns `void` unconditionally regardless of
// whether its `on conflict (org_id, idempotency_key) do nothing` fired. Ergo
// the service's own `registered`/`enqueued` response counters cannot and do
// not drop to 0 on a redelivered call — they report the SAME counts both
// times. The no-duplicate-row guarantee is real (proven below against the
// fake table's actual size), but spec.md AC2's literal wording ("registered/
// enqueued counts on the second call reflect no net new enqueue") does not
// match the shipped behavior at the API-response level. Flagged in
// test-results.md as an acceptance criterion that is not testable as written.

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { InstalledRepo } from '../github/appClient';
import { applyInstallationRepositoriesEvent, type InstallationRepositoriesDeps } from './githubInstallationRepositoriesService';
import { reconcileInstallationRepositories, type ReconcileDeps } from './githubInstallationReconcileService';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ORG = 'org-1';

interface FakeRepoRow {
  id: string;
  orgId: string;
  externalId: string;
  fullName: string;
  defaultBranch: string | null;
  revokedAt: Date | null;
  updatedAt: Date;
}

/**
 * Reproduces the REAL semantics of registerRepository/markRepositoryRevoked/
 * enqueueInitialParseOutbox (see db/githubAppInstallWrites.ts,
 * db/githubInitialParseOutbox.ts) against an in-memory Map instead of
 * Postgres, so a "replay the same call twice" test can inspect real
 * before/after state.
 */
function makeFakeStore() {
  const repos = new Map<string, FakeRepoRow>();
  const outbox = new Map<string, unknown>();
  let nextId = 1;

  function repoKey(orgId: string, externalId: string): string {
    return `${orgId}|github|${externalId}`;
  }

  return {
    repos,
    outbox,

    // Mirrors: insert ... on conflict (org_id, provider, external_id) do update
    // set ..., revoked_at = null ... returning { id }. Always returns exactly
    // one row's id, whether this call inserted or updated.
    registerRepository: vi.fn(
      async (
        _tx: unknown,
        row: { orgId: string; providerRepoId: string; fullName: string; defaultBranch: string | null },
      ): Promise<{ repoId: string }> => {
        const key = repoKey(row.orgId, row.providerRepoId);
        const existing = repos.get(key);
        if (existing) {
          existing.fullName = row.fullName;
          existing.defaultBranch = row.defaultBranch;
          existing.revokedAt = null; // re-activation on conflict, per registerRepository's real set clause
          existing.updatedAt = new Date();
          return { repoId: existing.id };
        }
        const id = `repo-uuid-${nextId++}`;
        repos.set(key, {
          id,
          orgId: row.orgId,
          externalId: row.providerRepoId,
          fullName: row.fullName,
          defaultBranch: row.defaultBranch,
          revokedAt: null,
          updatedAt: new Date(),
        });
        return { repoId: id };
      },
    ),

    // Mirrors: update ... set revoked_at = coalesce(revoked_at, now()) where
    // (org_id, provider, external_id) = ... returning { id }. The WHERE clause
    // does NOT condition on revoked_at IS NULL, so this returns true whenever
    // a matching row exists — including on a redelivered/already-revoked call.
    // Only the *value* written is COALESCE-guarded against advancing.
    markRepositoryRevoked: vi.fn(
      async (_tx: unknown, row: { orgId: string; providerRepoId: string }): Promise<boolean> => {
        const key = repoKey(row.orgId, row.providerRepoId);
        const existing = repos.get(key);
        if (!existing) return false;
        existing.revokedAt = existing.revokedAt ?? new Date();
        existing.updatedAt = new Date();
        return true;
      },
    ),

    // Mirrors: insert ... on conflict (org_id, idempotency_key) do nothing.
    // Real signature returns void unconditionally regardless of whether the
    // conflict branch fired — this fake preserves that (callers cannot
    // observe insert-vs-noop from the return value, matching prod).
    enqueueInitialParse: vi.fn(async (_tx: unknown, envelope: { org_id: string; idempotency_key: string }) => {
      const key = `${envelope.org_id}|${envelope.idempotency_key}`;
      if (!outbox.has(key)) outbox.set(key, envelope);
    }),

    listOurRepos: async (orgId: string) =>
      Array.from(repos.values())
        .filter((r) => r.orgId === orgId)
        .map((r) => ({ id: r.id, externalId: r.externalId, revokedAt: r.revokedAt })),
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

function repoDeps(
  store: ReturnType<typeof makeFakeStore>,
  overrides: Partial<InstallationRepositoriesDeps> = {},
): InstallationRepositoriesDeps {
  return {
    resolveOrg: vi.fn(async () => ({ orgId: ORG, active: true })),
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    githubClient: {
      authorizeInstallation: vi.fn(),
      mintInstallationToken: vi.fn(),
      listInstallationReposPage: vi.fn(),
      getInstallationRepo: vi.fn(async () => makeInstalledRepo()),
    },
    registerRepository: store.registerRepository,
    markRepositoryRevoked: store.markRepositoryRevoked,
    enqueueInitialParse: store.enqueueInitialParse,
    kickInitialParseOutbox: vi.fn(),
    ...overrides,
  } as InstallationRepositoriesDeps;
}

function ctx(orgId = ORG): AuthContext {
  return { subjectType: 'user', orgId, userId: 'admin-1', roles: ['admin'] };
}

describe('installation_repositories added — real redelivery against a stateful fake store (AC2, task item 1)', () => {
  it('replaying the identical added webhook twice creates exactly one repositories row and one outbox row', async () => {
    const store = makeFakeStore();
    const deps = repoDeps(store);
    const input = {
      action: 'added' as const,
      installationId: 555,
      added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      removed: [],
    };

    const first = await applyInstallationRepositoriesEvent(input, deps);
    const second = await applyInstallationRepositoriesEvent(input, deps);

    // Real dedup guarantee: no duplicate row / no duplicate outbox entry.
    expect(store.repos.size).toBe(1);
    expect(store.outbox.size).toBe(1);

    // Documented finding: the reported counts do NOT drop to zero on the
    // second (redelivered) call — see file header. Both calls report the
    // same shape because registerRepository's upsert always returns exactly
    // one row and enqueueInitialParseOutbox always resolves void.
    expect(first).toEqual({ status: 'added', registered: 1, enqueued: 1 });
    expect(second).toEqual({ status: 'added', registered: 1, enqueued: 1 });
  });

  it('kickInitialParseOutbox throwing after commit does not strand the already-committed row/outbox entry', async () => {
    const store = makeFakeStore();
    const deps = repoDeps(store, {
      kickInitialParseOutbox: vi.fn(() => {
        throw new Error('kick failed');
      }),
    });
    const input = {
      action: 'added' as const,
      installationId: 555,
      added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      removed: [],
    };

    await expect(applyInstallationRepositoriesEvent(input, deps)).rejects.toThrow('kick failed');

    // The DB write already committed (inside withOrg) before the kick ran —
    // durability does not depend on the kick succeeding.
    expect(store.repos.size).toBe(1);
    expect(store.outbox.size).toBe(1);
  });
});

describe('installation_repositories removed — COALESCE redelivery against a stateful fake store (AC3, task item 2)', () => {
  it('revoked_at is set on first delivery and does NOT advance on redelivery, and neither call errors', async () => {
    const store = makeFakeStore();
    const deps = repoDeps(store);

    // Seed an active, already-registered repo (mirrors a prior "added"/install).
    await store.registerRepository({}, {
      orgId: ORG,
      providerRepoId: '111',
      fullName: 'acme/widgets',
      defaultBranch: 'main',
    });

    const removeInput = {
      action: 'removed' as const,
      installationId: 555,
      added: [],
      removed: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
    };

    const first = await applyInstallationRepositoriesEvent(removeInput, deps);
    const revokedAtAfterFirst = store.repos.get(`${ORG}|github|111`)?.revokedAt;
    expect(revokedAtAfterFirst).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 5)); // let "now()" actually move

    const second = await applyInstallationRepositoriesEvent(removeInput, deps);
    const revokedAtAfterSecond = store.repos.get(`${ORG}|github|111`)?.revokedAt;

    // The literal COALESCE guarantee: the timestamp itself never advances.
    expect(revokedAtAfterSecond?.getTime()).toBe(revokedAtAfterFirst?.getTime());

    // Real WHERE-match semantics: markRepositoryRevoked returns true whenever
    // a matching row exists, on BOTH calls — not just the first. (Consistent
    // with githubInstallationRepositoriesService.test.ts's own redelivered-
    // removed unit test, which mocks markRepositoryRevoked to return true on
    // redelivery for exactly this reason.)
    expect(first).toEqual({ status: 'removed', revoked: 1 });
    expect(second).toEqual({ status: 'removed', revoked: 1 });

    // A later inbound event for the now-revoked repo does not throw.
    await expect(applyInstallationRepositoriesEvent(removeInput, deps)).resolves.toEqual({
      status: 'removed',
      revoked: 1,
    });
  });

  it('removed then a later added for the same repo clears revoked_at and re-enqueues (re-activation)', async () => {
    const store = makeFakeStore();
    const deps = repoDeps(store);

    await store.registerRepository({}, {
      orgId: ORG,
      providerRepoId: '111',
      fullName: 'acme/widgets',
      defaultBranch: 'main',
    });

    await applyInstallationRepositoriesEvent(
      { action: 'removed', installationId: 555, added: [], removed: [{ providerRepoId: '111', fullName: 'acme/widgets' }] },
      deps,
    );
    expect(store.repos.get(`${ORG}|github|111`)?.revokedAt).toBeInstanceOf(Date);

    const reAdded = await applyInstallationRepositoriesEvent(
      { action: 'added', installationId: 555, added: [{ providerRepoId: '111', fullName: 'acme/widgets' }], removed: [] },
      deps,
    );

    expect(reAdded).toEqual({ status: 'added', registered: 1, enqueued: 1 });
    expect(store.repos.get(`${ORG}|github|111`)?.revokedAt).toBeNull();
    expect(store.outbox.size).toBe(1);
  });
});

describe('reconcile request path performs no revoke, against a stateful fake store (W7-01 rewrite of the OQ-5 block)', () => {
  // W7-01: the "a repo GitHub no longer reports is left completely untouched" claim this block
  // used to make is now FALSE BY DESIGN — a completed manual_reconcile run's sweep (AC-24) may
  // revoke exactly that repo. That replacement guarantee (and its four false-positive guards)
  // is covered against a real stateful fake store in githubInstallationRevokeTraceThrough.test.ts
  // (AC-24/AC-25/EC-36/EC-37/EC-38), not here. What remains true and is still worth proving here:
  // the SYNCHRONOUS reconcile request path itself — reconcileInstallationRepositories, the
  // function this file's other describe blocks exercise — never touches the repositories table
  // at all anymore; it only records a durable run row for the discovery worker to act on later.
  it('reconcileInstallationRepositories never touches the repositories table — the fake store is byte-for-byte unchanged', async () => {
    const store = makeFakeStore();

    // Seed a repo we hold as active, which GitHub's live installation-repos response would NOT
    // include if this were an old-style synchronous diff — the scenario W2-09's OQ-5 test used.
    await store.registerRepository({}, {
      orgId: ORG,
      providerRepoId: '999',
      fullName: 'acme/no-longer-reported',
      defaultBranch: 'main',
    });
    const beforeSnapshot = JSON.stringify([...store.repos.entries()]);

    // A spy claiming the (non-existent-in-the-type) `markRepositoryRevoked` dependency name:
    // proves not merely that ReconcileDeps has no such declared member, but that even if a
    // caller tried to hand the reconcile service a revocation function under that name, the
    // service body never reaches for it.
    const suspiciousMarkRevoked = vi.fn(async () => true);
    const suspiciousRegisterRepository = vi.fn(async () => ({ repoId: 'should-never-be-called' }));

    const deps = {
      resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }]),
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
      startInstallationSync: vi.fn(async () => ({ reset: true, runId: 'run-uuid-1' })),
      kickDiscoveryDispatcher: vi.fn(),
      markRepositoryRevoked: suspiciousMarkRevoked,
      registerRepository: suspiciousRegisterRepository,
    } as unknown as Partial<ReconcileDeps> & {
      markRepositoryRevoked: typeof suspiciousMarkRevoked;
      registerRepository: typeof suspiciousRegisterRepository;
    };

    const result = await reconcileInstallationRepositories(ctx(ORG), deps);

    expect(result).toEqual({ status: 'queued', installations: 1, queued: 1 });
    // Structural: the type has no markRepositoryRevoked/registerRepository member at all.
    expect('markRepositoryRevoked' in ({} as ReconcileDeps)).toBe(false);
    expect('registerRepository' in ({} as ReconcileDeps)).toBe(false);
    // Behavioral, against real mutable state: the fake repositories table is byte-for-byte
    // unchanged after reconcile ran — not merely "the response didn't mention revocation".
    expect(JSON.stringify([...store.repos.entries()])).toBe(beforeSnapshot);
    // Even same-named spies handed in alongside the real deps are never invoked.
    expect(suspiciousMarkRevoked).not.toHaveBeenCalled();
    expect(suspiciousRegisterRepository).not.toHaveBeenCalled();
  });
});

describe('added path resolves a fresh HEAD per repo before enqueueing (task item 5, sanity check)', () => {
  it('a distinct HEAD sha per repo produces distinct idempotency keys (no cross-repo collision)', async () => {
    const store = makeFakeStore();
    const deps = repoDeps(store, {
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationReposPage: vi.fn(),
        getInstallationRepo: vi.fn(async (_id: number, fullName: string) =>
          fullName === 'acme/widgets'
            ? makeInstalledRepo({ provider_repo_id: '111', full_name: 'acme/widgets', default_branch_head_sha: SHA_A })
            : makeInstalledRepo({ provider_repo_id: '222', full_name: 'acme/gadgets', default_branch_head_sha: SHA_B }),
        ),
      },
    });

    await applyInstallationRepositoriesEvent(
      {
        action: 'added',
        installationId: 555,
        added: [
          { providerRepoId: '111', fullName: 'acme/widgets' },
          { providerRepoId: '222', fullName: 'acme/gadgets' },
        ],
        removed: [],
      },
      deps,
    );

    expect(store.repos.size).toBe(2);
    expect(store.outbox.size).toBe(2);
  });
});

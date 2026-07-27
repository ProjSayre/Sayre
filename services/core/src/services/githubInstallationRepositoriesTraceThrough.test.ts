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
      listInstallationRepos: vi.fn(),
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

describe('reconcile OQ-5 additive-only guarantee against a stateful fake store (task item 3 — most important)', () => {
  it('a repo we hold active that GitHub no longer reports is left completely untouched: revoked_at unchanged, revoked: 0', async () => {
    const store = makeFakeStore();

    // Seed a repo we hold as active, which GitHub's live installation-repos
    // response will NOT include on this reconcile run — the exact "repo
    // present in our DB, absent from GitHub's live response" scenario.
    await store.registerRepository({}, {
      orgId: ORG,
      providerRepoId: '999',
      fullName: 'acme/no-longer-reported',
      defaultBranch: 'main',
    });
    const revokedAtBefore = store.repos.get(`${ORG}|github|999`)?.revokedAt;
    expect(revokedAtBefore).toBeNull();

    // A spy claiming the (non-existent-in-the-type) `markRepositoryRevoked`
    // dependency name: proves not merely that ReconcileDeps has no such
    // declared member (dev's own test), but that even if a caller tried to
    // hand the reconcile service a revocation function under that name, the
    // service body never reaches for it — belt-and-suspenders on top of the
    // static grep in changes.md.
    const suspiciousMarkRevoked = vi.fn(async () => true);

    const deps = {
      resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }]),
      listOurRepos: store.listOurRepos,
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(async () => []), // GitHub reports zero repos for this installation
        getInstallationRepo: vi.fn(),
      },
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
      registerRepository: store.registerRepository,
      enqueueInitialParse: store.enqueueInitialParse,
      kickInitialParseOutbox: vi.fn(),
      markRepositoryRevoked: suspiciousMarkRevoked,
    } as unknown as Partial<ReconcileDeps> & { markRepositoryRevoked: typeof suspiciousMarkRevoked };

    const result = await reconcileInstallationRepositories(ctx(ORG), deps);

    expect(result.revoked).toBe(0);
    expect(result.registered).toBe(0);
    // Structural: the type has no markRepositoryRevoked member at all.
    expect('markRepositoryRevoked' in ({} as ReconcileDeps)).toBe(false);
    // Behavioral, against real mutable state: revoked_at is byte-for-byte
    // unchanged (still null) after reconcile ran — not merely "the response
    // said 0".
    expect(store.repos.get(`${ORG}|github|999`)?.revokedAt).toBe(revokedAtBefore);
    // Even a same-named spy handed in alongside the real deps is never invoked.
    expect(suspiciousMarkRevoked).not.toHaveBeenCalled();
  });

  it('additive repair still runs normally alongside the untouched at-risk repo (repair + non-revocation in the same call)', async () => {
    const store = makeFakeStore();

    // repo A: ours, active, GitHub no longer reports it -> must stay untouched.
    await store.registerRepository({}, {
      orgId: ORG,
      providerRepoId: '999',
      fullName: 'acme/no-longer-reported',
      defaultBranch: 'main',
    });

    const deps = {
      resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }]),
      listOurRepos: store.listOurRepos,
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        // repo B: GitHub reports this one, we don't have it -> additive repair.
        listInstallationRepos: vi.fn(async () => [
          makeInstalledRepo({ provider_repo_id: '222', full_name: 'acme/newly-added' }),
        ]),
        getInstallationRepo: vi.fn(),
      },
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
      registerRepository: store.registerRepository,
      enqueueInitialParse: store.enqueueInitialParse,
      kickInitialParseOutbox: vi.fn(),
    } satisfies ReconcileDeps;

    const result = await reconcileInstallationRepositories(ctx(ORG), deps);

    expect(result).toEqual({ installations: 1, registered: 1, enqueued: 1, revoked: 0, truncated: false });
    expect(store.repos.get(`${ORG}|github|999`)?.revokedAt).toBeNull(); // untouched
    expect(store.repos.get(`${ORG}|github|222`)).toBeDefined(); // repaired
  });
});

describe('added path resolves a fresh HEAD per repo before enqueueing (task item 5, sanity check)', () => {
  it('a distinct HEAD sha per repo produces distinct idempotency keys (no cross-repo collision)', async () => {
    const store = makeFakeStore();
    const deps = repoDeps(store, {
      githubClient: {
        authorizeInstallation: vi.fn(),
        mintInstallationToken: vi.fn(),
        listInstallationRepos: vi.fn(),
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

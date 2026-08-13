// Leading-red tests (W7-01) for githubInstallationDiscoveryService.ts — the paginated discovery
// worker + OQ-4 revoke sweep. This module does not exist yet, so every test below fails today
// with a module-resolution error (RED-CORRECT: "a missing function", the whole implementation).
// DI-mocked, no real Postgres/network — mirrors githubInstallationReconcileService.test.ts's and
// githubInstallationRepositoriesTraceThrough.test.ts's conventions. Structural/DB-privilege
// aspects of AC-13/AC-14 that require a live Postgres are covered (deferred) in
// db/githubInstallationSync.rls.test.ts; AC-9's queue-routing aspect is covered in
// integrations/git/worker.discoveryRouting.test.ts; AC-28/AC-29/EC-36/EC-37/EC-38's structural
// "exactly two revoke call sites" + reversibility guarantee is covered against a stateful fake
// store in githubInstallationRevokeTraceThrough.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';
import type { GithubAppClient, InstallationRepoPage, InstalledRepo } from '../github/appClient';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ORG = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const INSTALLATION_ID = 555;

// The real payload/envelope shape spec.md's Interfaces section assigns to
// GithubInstallationDiscoveryPayload / buildInstallationDiscoveryEnvelope, constructed by hand
// (rather than importing from ../queue/bullmq, which does not export these yet) so a failure in
// THIS file always points at githubInstallationDiscoveryService.ts, not at collateral bullmq gaps.
interface DiscoveryPayload {
  provider: 'github';
  type: 'installation_discovery';
  installation_id: string;
  run_id: string;
  reason: 'app_install' | 'manual_reconcile';
}

function discoveryEnvelope(
  overrides: Partial<DiscoveryPayload> & { orgId?: string; runId?: string } = {},
): MessageEnvelope<DiscoveryPayload> {
  const runId = overrides.runId ?? RUN_ID;
  const reason = overrides.reason ?? 'app_install';
  return makeEnvelope<DiscoveryPayload>({
    org_id: overrides.orgId ?? ORG,
    type: 'github.installation_discovery',
    source: reason === 'app_install' ? 'github-app-install' : 'github-reconcile',
    trace_id: `installation:${INSTALLATION_ID}`,
    idempotency_key: ['github', 'installation_discovery', INSTALLATION_ID, runId].join(':'),
    payload: {
      provider: 'github',
      type: 'installation_discovery',
      installation_id: String(INSTALLATION_ID),
      run_id: runId,
      reason,
    },
  });
}

function makeRepo(overrides: Partial<InstalledRepo> = {}): InstalledRepo {
  return {
    provider_repo_id: '1',
    full_name: 'acme/widgets',
    default_branch: 'main',
    default_branch_head_sha: SHA_A,
    ...overrides,
  };
}

/** Deterministic fake GithubAppClient.listInstallationReposPage over a fixed repo list. */
function makeGithubClient(repos: InstalledRepo[], perPage = 100): GithubAppClient {
  const calls: number[] = [];
  const listInstallationReposPage = vi.fn(
    async (_installationId: number, page: number): Promise<InstallationRepoPage> => {
      calls.push(page);
      const start = (page - 1) * perPage;
      const pageRepos = repos.slice(start, start + perPage);
      return {
        repos: pageRepos,
        page,
        hasNextPage: pageRepos.length === perPage,
        totalCount: repos.length,
      };
    },
  );
  return {
    authorizeInstallation: vi.fn(),
    mintInstallationToken: vi.fn(),
    getInstallationRepo: vi.fn(),
    listInstallationReposPage,
  } as unknown as GithubAppClient;
}

function fixture(count: number, options: { emptyBranchIndices?: number[] } = {}): InstalledRepo[] {
  const empty = new Set(options.emptyBranchIndices ?? []);
  return Array.from({ length: count }, (_, i) =>
    empty.has(i)
      ? makeRepo({ provider_repo_id: String(i), full_name: `acme/repo-${i}`, default_branch: null, default_branch_head_sha: null })
      : makeRepo({ provider_repo_id: String(i), full_name: `acme/repo-${i}`, default_branch_head_sha: i % 2 === 0 ? SHA_A : SHA_B }),
  );
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const advanceCalls: unknown[] = [];
  return {
    resolveInstallationOrg: vi.fn(async () => ({ orgId: ORG, active: true })),
    githubClient: makeGithubClient(fixture(0)),
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    claimInstallationSync: vi.fn(async () => ({ nextPage: 1, runId: RUN_ID, startedAt: new Date('2026-08-01T00:00:00Z') })),
    advanceInstallationSyncPage: vi.fn(async (input: unknown) => {
      advanceCalls.push(input);
      return true;
    }),
    completeInstallationSync: vi.fn(async () => undefined),
    failInstallationSync: vi.fn(async () => undefined),
    cancelInstallationSync: vi.fn(async () => undefined),
    recordSweepOutcome: vi.fn(async () => undefined),
    registerRepository: vi.fn(async () => ({ repoId: 'repo-uuid' })),
    enqueueInitialParse: vi.fn(async () => undefined),
    kickInitialParseOutbox: vi.fn(),
    listActiveInstallationsForOrg: vi.fn(async () => [{ installationId: INSTALLATION_ID }]),
    listInstallationSyncRows: vi.fn(async () => [
      { installationId: INSTALLATION_ID, completedRunId: RUN_ID } as unknown,
    ]),
    listRevokeSweepCandidates: vi.fn(async () => []),
    countActiveGithubRepositories: vi.fn(async () => 0),
    markRepositoryRevoked: vi.fn(async () => true),
    ...overrides,
    __advanceCalls: advanceCalls,
  };
}

async function loadService() {
  return import('./githubInstallationDiscoveryService');
}

describe('runInstallationDiscovery — AC-4/AC-5/AC-6/AC-9 (120-repo fixture, full pagination + registration)', () => {
  // @spec AC-4 AC-5 AC-6 AC-9
  it('issues exactly 2 page requests for a 120-repo installation, registers/enqueues each repo once, commits per-page before the next fetch, and ends complete', async () => {
    const { runInstallationDiscovery } = await loadService();
    const repos = fixture(120);
    const githubClient = makeGithubClient(repos);
    const registered: string[] = [];
    const enqueued: string[] = [];
    const order: string[] = [];

    const deps = makeDeps({
      githubClient,
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
        order.push('tx-open');
        const result = await fn({});
        order.push('tx-commit');
        return result;
      }),
      registerRepository: vi.fn(async (_tx: unknown, row: { providerRepoId: string; discoveryRunId?: string }) => {
        registered.push(row.providerRepoId);
        expect(row.discoveryRunId).toBe(RUN_ID);
        return { repoId: `repo-${row.providerRepoId}` };
      }),
      enqueueInitialParse: vi.fn(async (_tx: unknown, env: MessageEnvelope<unknown>) => {
        enqueued.push((env.payload as { repo: { provider_repo_id: string } }).repo.provider_repo_id);
      }),
      claimInstallationSync: vi.fn(async () => {
        order.push('claim');
        return { nextPage: 1, runId: RUN_ID, startedAt: new Date('2026-08-01T00:00:00Z') };
      }),
      completeInstallationSync: vi.fn(async () => order.push('complete')),
    });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect((githubClient.listInstallationReposPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(registered).toHaveLength(120);
    expect(new Set(registered).size).toBe(120); // each repo registered exactly once
    expect(enqueued).toHaveLength(120); // every fixture repo has a branch + HEAD sha
    expect(result).toMatchObject({ status: 'complete', pages: 2, discovered: 120, registered: 120, enqueued: 120 });
    // AC-6: the transaction opens/commits around each page's writes — network (the page fetch)
    // is never inside an open transaction span (claim happens before any tx-open in this fake).
    expect(order[0]).toBe('claim');
    expect(order.filter((step) => step === 'tx-open')).toHaveLength(2); // one commit per page + completion
  });
});

describe('runInstallationDiscovery — AC-7 (resumed run does not re-fetch an already-committed page)', () => {
  // @spec AC-7
  it('resumes at page 2 when claimInstallationSync reports nextPage=2, never re-fetching page 1', async () => {
    const { runInstallationDiscovery } = await loadService();
    const repos = fixture(120);
    const githubClient = makeGithubClient(repos);
    const deps = makeDeps({
      githubClient,
      claimInstallationSync: vi.fn(async () => ({ nextPage: 2, runId: RUN_ID, startedAt: new Date() })),
    });

    await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    const pagesFetched = (githubClient.listInstallationReposPage as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[1],
    );
    expect(pagesFetched).toEqual([2]);
    expect(deps.registerRepository).toHaveBeenCalledTimes(20); // only page 2's 20 repos
  });
});

describe('runInstallationDiscovery — AC-8 (60s discovery target constant)', () => {
  // @spec AC-8
  it('exports INSTALLATION_DISCOVERY_TARGET_MS as 60000', async () => {
    const service = await loadService();
    expect(service.INSTALLATION_DISCOVERY_TARGET_MS).toBe(60_000);
  });
});

describe('runInstallationDiscovery — AC-15 (page CAS: a superseded advance stops the run without duplicating writes)', () => {
  // @spec AC-15
  it('when advanceInstallationSyncPage returns false (stale cursor/run id), the run stops as superseded without fetching or writing another page', async () => {
    const { runInstallationDiscovery } = await loadService();
    const repos = fixture(200); // 2 pages
    const githubClient = makeGithubClient(repos);
    const deps = makeDeps({
      githubClient,
      advanceInstallationSyncPage: vi.fn(async () => false), // another runner already advanced past this page
    });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(githubClient.listInstallationReposPage).toHaveBeenCalledTimes(1); // never reaches page 2
    expect(result.status).toBe('cancelled');
    expect(deps.completeInstallationSync).not.toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-14 (page ceiling: does not rethrow, not redispatchable)', () => {
  // @spec EC-14
  it('an installation reporting full pages past MAX_INSTALLATION_DISCOVERY_PAGES stops at the ceiling, fails(page_limit_exceeded), and does NOT rethrow', async () => {
    const service = await loadService();
    const { runInstallationDiscovery, MAX_INSTALLATION_DISCOVERY_PAGES } = service;
    // Always-full pages: the loop can never see hasNextPage=false on its own.
    const listInstallationReposPage = vi.fn(async (_id: number, page: number) => ({
      repos: fixture(100),
      page,
      hasNextPage: true,
      totalCount: null,
    }));
    const githubClient = { ...makeGithubClient([]), listInstallationReposPage } as GithubAppClient;
    const deps = makeDeps({ githubClient });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(githubClient.listInstallationReposPage).toHaveBeenCalledTimes(MAX_INSTALLATION_DISCOVERY_PAGES);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'page_limit_exceeded' });
    expect(deps.failInstallationSync).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'page_limit_exceeded' }),
    );
  });
});

describe('runInstallationDiscovery — AC-13 (tenant isolation: org_id only from the envelope, re-verified)', () => {
  // @spec AC-13
  it('uses envelope.org_id (never payload) and re-verifies it against resolveInstallationOrg before any write', async () => {
    const { runInstallationDiscovery } = await loadService();
    const resolveInstallationOrg = vi.fn(async () => ({ orgId: ORG, active: true }));
    const deps = makeDeps({ resolveInstallationOrg, githubClient: makeGithubClient(fixture(1)) });

    await runInstallationDiscovery(discoveryEnvelope({ orgId: ORG }), deps as never);

    expect(resolveInstallationOrg).toHaveBeenCalledWith(INSTALLATION_ID);
    expect(deps.withOrg).toHaveBeenCalledWith(ORG, expect.any(Function));
  });

  // @spec AC-13
  it('org_mismatch: resolveInstallationOrg reports a DIFFERENT org than envelope.org_id -> zero writes, cancelled', async () => {
    const { runInstallationDiscovery } = await loadService();
    const deps = makeDeps({
      resolveInstallationOrg: vi.fn(async () => ({ orgId: 'a-different-org', active: true })),
    });

    const result = await runInstallationDiscovery(discoveryEnvelope({ orgId: ORG }), deps as never);

    expect(result).toEqual({ status: 'cancelled', reason: 'org_mismatch' });
    expect(deps.withOrg).not.toHaveBeenCalled();
    expect(deps.registerRepository).not.toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-6 (unknown installation)', () => {
  // @spec EC-6
  it('resolveInstallationOrg returns null -> zero writes, cancelled: unknown_installation', async () => {
    const { runInstallationDiscovery } = await loadService();
    const deps = makeDeps({ resolveInstallationOrg: vi.fn(async () => null) });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(result).toEqual({ status: 'cancelled', reason: 'unknown_installation' });
    expect(deps.withOrg).not.toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-1 (zero-repo installation)', () => {
  // @spec EC-1
  it('empty page 1, hasNextPage false -> complete with all counts 0 and no outbox row', async () => {
    const { runInstallationDiscovery } = await loadService();
    const deps = makeDeps({ githubClient: makeGithubClient([]) });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(result).toMatchObject({ status: 'complete', discovered: 0, registered: 0, enqueued: 0 });
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-2 (exactly 100 repos, page-size boundary)', () => {
  // @spec EC-2
  it('a full page-1 (100) triggers an empty page-2 fetch, completing with exactly 100 registered, none duplicated or missed', async () => {
    const { runInstallationDiscovery } = await loadService();
    const githubClient = makeGithubClient(fixture(100));
    const deps = makeDeps({ githubClient });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(githubClient.listInstallationReposPage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'complete', pages: 2, registered: 100 });
  });
});

describe('runInstallationDiscovery — EC-3 (empty repo: no branch/HEAD)', () => {
  // @spec EC-3
  it('registers an empty repo but does not enqueue it', async () => {
    const { runInstallationDiscovery } = await loadService();
    const githubClient = makeGithubClient(fixture(1, { emptyBranchIndices: [0] }));
    const deps = makeDeps({ githubClient });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(result).toMatchObject({ registered: 1, enqueued: 0 });
    expect(deps.enqueueInitialParse).not.toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-4 (provider 5xx mid-run: cursor preserved, rethrows)', () => {
  // @spec EC-4
  it('a page-3-of-5 failure leaves pages 1-2 committed, marks the row failed(provider_unavailable) with the cursor at 3, and rethrows', async () => {
    const { runInstallationDiscovery } = await loadService();
    const repos = fixture(500); // 5 pages of 100
    const githubClient = makeGithubClient(repos);
    (githubClient.listInstallationReposPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: number, page: number) => {
        if (page === 3) throw new Error('GitHub API request returned 503.');
        const start = (page - 1) * 100;
        return { repos: repos.slice(start, start + 100), page, hasNextPage: page < 5, totalCount: 500 };
      },
    );
    const deps = makeDeps({ githubClient });

    await expect(runInstallationDiscovery(discoveryEnvelope(), deps as never)).rejects.toThrow();

    expect(deps.failInstallationSync).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'provider_unavailable' }),
    );
    expect(deps.completeInstallationSync).not.toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-5 (installation suspended mid-discovery)', () => {
  // @spec EC-5
  it('the active re-check fails on a later page -> cancelled, no further repository or outbox writes', async () => {
    const { runInstallationDiscovery } = await loadService();
    const repos = fixture(200); // 2 pages
    const githubClient = makeGithubClient(repos);
    let call = 0;
    const resolveInstallationOrg = vi.fn(async () => {
      call += 1;
      return { orgId: ORG, active: call === 1 }; // active on the first (pre-loop) check only
    });
    const deps = makeDeps({ githubClient, resolveInstallationOrg });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(result).toMatchObject({ status: 'cancelled', reason: 'inactive_installation' });
    expect(deps.cancelInstallationSync).toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-10 (redelivered job after the run already completed)', () => {
  // @spec EC-10
  it('claimInstallationSync returns null -> exits without re-fetching or re-writing anything', async () => {
    const { runInstallationDiscovery } = await loadService();
    const githubClient = makeGithubClient(fixture(5));
    const deps = makeDeps({ githubClient, claimInstallationSync: vi.fn(async () => null) });

    const result = await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(result.status).toBe('cancelled');
    expect(githubClient.listInstallationReposPage).not.toHaveBeenCalled();
    expect(deps.registerRepository).not.toHaveBeenCalled();
  });
});

describe('runInstallationDiscovery — EC-11 (same repo reported on two pages: idempotent, no duplicates)', () => {
  // @spec EC-11
  it('a repo id repeated across pages produces one row and one outbox delivery, not two', async () => {
    const { runInstallationDiscovery } = await loadService();
    const repoRows = new Map<string, { repoId: string }>();
    const outbox = new Set<string>();
    const page1 = Array.from({ length: 100 }, (_, i) => makeRepo({ provider_repo_id: String(i), full_name: `acme/repo-${i}` }));
    // GitHub re-orders: repo '0' also appears on page 2.
    const page2 = [makeRepo({ provider_repo_id: '0', full_name: 'acme/repo-0' }), makeRepo({ provider_repo_id: '100', full_name: 'acme/repo-100' })];
    const listInstallationReposPage = vi.fn(async (_id: number, page: number) =>
      page === 1
        ? { repos: page1, page: 1, hasNextPage: true, totalCount: 102 }
        : { repos: page2, page: 2, hasNextPage: false, totalCount: 102 },
    );
    const githubClient = { ...makeGithubClient([]), listInstallationReposPage } as GithubAppClient;

    const deps = makeDeps({
      githubClient,
      registerRepository: vi.fn(async (_tx: unknown, row: { providerRepoId: string }) => {
        // Mirrors the real upsert: same key -> same row, no duplicate.
        const existing = repoRows.get(row.providerRepoId);
        if (existing) return existing;
        const created = { repoId: `repo-${row.providerRepoId}` };
        repoRows.set(row.providerRepoId, created);
        return created;
      }),
      enqueueInitialParse: vi.fn(async (_tx: unknown, env: MessageEnvelope<unknown>) => {
        // Mirrors the real (org_id, idempotency_key) DO NOTHING.
        outbox.add(env.idempotency_key);
      }),
    });

    await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(repoRows.size).toBe(101); // repo 0 counted once, plus 1..100
    expect(outbox.size).toBe(101);
  });
});

describe('runInstallationDiscovery — EC-13 (total_count never fabricates a denominator)', () => {
  // @spec EC-13
  it('passes appClient-reported totalCount through to advanceInstallationSyncPage unchanged, including null', async () => {
    const { runInstallationDiscovery } = await loadService();
    const githubClient = makeGithubClient(fixture(1));
    (githubClient.listInstallationReposPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      repos: fixture(1),
      page: 1,
      hasNextPage: false,
      totalCount: null,
    });
    const advanceInstallationSyncPage = vi.fn(async () => true);
    const deps = makeDeps({ githubClient, advanceInstallationSyncPage });

    await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(advanceInstallationSyncPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ totalCount: null }),
    );
  });
});

describe('runInstallationDiscovery — EC-19 (re-running discovery re-registers already-known repos)', () => {
  // @spec EC-19
  it('every discovered repo (including a previously-registered one) goes through registerRepository with this run id', async () => {
    const { runInstallationDiscovery } = await loadService();
    const githubClient = makeGithubClient(fixture(3));
    const registerRepository = vi.fn(async (_tx: unknown, row: { discoveryRunId?: string }) => {
      expect(row.discoveryRunId).toBe(RUN_ID);
      return { repoId: 'repo-uuid' };
    });
    const deps = makeDeps({ githubClient, registerRepository });

    await runInstallationDiscovery(discoveryEnvelope(), deps as never);

    expect(registerRepository).toHaveBeenCalledTimes(3);
  });
});

describe('runInstallationDiscovery — the OQ-4 revoke sweep', () => {
  function completeManualReconcileDeps(overrides: Record<string, unknown> = {}) {
    return makeDeps({
      githubClient: makeGithubClient(fixture(1)),
      listActiveInstallationsForOrg: vi.fn(async () => [{ installationId: INSTALLATION_ID }]),
      listInstallationSyncRows: vi.fn(async () => [{ installationId: INSTALLATION_ID, completedRunId: RUN_ID }]),
      countActiveGithubRepositories: vi.fn(async () => 1),
      listRevokeSweepCandidates: vi.fn(async () => []),
      // FND-cf76b24c5057: the sweep's authorization gate now reads `claimed.reason` (the
      // worker-side row read), never `envelope.payload.reason` — every test in this describe
      // block simulates a row whose OWN stored reason genuinely is 'manual_reconcile' (matching
      // discoveryEnvelope's default reason override below), unless a test explicitly overrides
      // claimInstallationSync itself (AC-25's app_install case, and the reason/row-mismatch test).
      claimInstallationSync: vi.fn(async () => ({
        nextPage: 1,
        runId: RUN_ID,
        startedAt: new Date('2026-08-01T00:00:00Z'),
        reason: 'manual_reconcile' as const,
      })),
      ...overrides,
    });
  }

  // @spec AC-24
  it('a completed manual_reconcile run revokes every observed-absent active repo, in the SAME transaction as completion, recording revoked_count and sweep_outcome=applied', async () => {
    const { runInstallationDiscovery } = await loadService();
    const order: string[] = [];
    const deps = completeManualReconcileDeps({
      listRevokeSweepCandidates: vi.fn(async () => [{ id: 'repo-x', externalId: '999' }]),
      countActiveGithubRepositories: vi.fn(async () => 2),
      markRepositoryRevoked: vi.fn(async () => {
        order.push('revoke');
        return true;
      }),
      completeInstallationSync: vi.fn(async () => order.push('complete')),
      recordSweepOutcome: vi.fn(async (input: { outcome: string; revokedCount: number }) => {
        order.push('recordSweepOutcome');
        expect(input.outcome).toBe('applied');
        expect(input.revokedCount).toBe(1);
      }),
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    });

    const result = await runInstallationDiscovery(
      discoveryEnvelope({ reason: 'manual_reconcile' }),
      deps as never,
    );

    expect(result).toMatchObject({ status: 'complete' });
    expect((result as { sweep: { outcome: string; revoked: number } }).sweep).toEqual({
      outcome: 'applied',
      revoked: 1,
    });
    expect(deps.markRepositoryRevoked).toHaveBeenCalledTimes(1);
    // completion and the sweep share one transaction — complete happens before recordSweepOutcome
    // finalizes, and both happen inside the same withOrg call as the sweep's own revoke.
    expect(order.indexOf('complete')).toBeLessThan(order.indexOf('recordSweepOutcome'));
  });

  // @spec AC-25 EC-35
  it('an app_install run never sweeps even when repos are missing: sweep stays not_applicable, revoked stays 0', async () => {
    const { runInstallationDiscovery } = await loadService();
    const deps = completeManualReconcileDeps({
      listRevokeSweepCandidates: vi.fn(async () => [{ id: 'repo-x', externalId: '999' }]),
      // The row's OWN reason (re-read by the worker via claimInstallationSync) genuinely is
      // 'app_install' here, matching the envelope — this proves the ordinary, non-mismatched
      // app_install case still never sweeps once authorization is sourced from the row.
      claimInstallationSync: vi.fn(async () => ({
        nextPage: 1,
        runId: RUN_ID,
        startedAt: new Date('2026-08-01T00:00:00Z'),
        reason: 'app_install' as const,
      })),
    });

    const result = await runInstallationDiscovery(discoveryEnvelope({ reason: 'app_install' }), deps as never);

    expect((result as { sweep: { outcome: string; revoked: number } }).sweep).toEqual({
      outcome: 'not_applicable',
      revoked: 0,
    });
    expect(deps.markRepositoryRevoked).not.toHaveBeenCalled();
    // The authorization decision is read from the row's stored reason alone — the sweep helper
    // must not even consult listRevokeSweepCandidates for a non-manual_reconcile run.
    expect(deps.listRevokeSweepCandidates).not.toHaveBeenCalled();
  });

  // @spec AC-27 EC-33
  it('withheld_coverage: an active installation of the org has no completed run', async () => {
    const { runInstallationDiscovery } = await loadService();
    const deps = completeManualReconcileDeps({
      listActiveInstallationsForOrg: vi.fn(async () => [{ installationId: INSTALLATION_ID }, { installationId: 777 }]),
      listInstallationSyncRows: vi.fn(async () => [
        { installationId: INSTALLATION_ID, completedRunId: RUN_ID },
        { installationId: 777, completedRunId: null },
      ]),
    });

    const result = await runInstallationDiscovery(discoveryEnvelope({ reason: 'manual_reconcile' }), deps as never);

    expect((result as { sweep: { outcome: string } }).sweep.outcome).toBe('withheld_coverage');
    expect(deps.markRepositoryRevoked).not.toHaveBeenCalled();
  });

  // @spec AC-27 EC-31
  it('withheld_empty_result: the run discovered zero repos while the org holds >=1 active repository', async () => {
    const { runInstallationDiscovery } = await loadService();
    const deps = completeManualReconcileDeps({
      githubClient: makeGithubClient([]),
      countActiveGithubRepositories: vi.fn(async () => 40),
    });

    const result = await runInstallationDiscovery(discoveryEnvelope({ reason: 'manual_reconcile' }), deps as never);

    expect((result as { sweep: { outcome: string } }).sweep.outcome).toBe('withheld_empty_result');
    expect(deps.markRepositoryRevoked).not.toHaveBeenCalled();
  });

  // @spec AC-27 EC-32
  it('withheld_ratio: candidates exceed both the row floor and the 50% blast-radius fraction', async () => {
    const { runInstallationDiscovery } = await loadService();
    const candidates = Array.from({ length: 97 }, (_, i) => ({ id: `repo-${i}`, externalId: String(i) }));
    const deps = completeManualReconcileDeps({
      listRevokeSweepCandidates: vi.fn(async () => candidates),
      countActiveGithubRepositories: vi.fn(async () => 100),
    });

    const result = await runInstallationDiscovery(discoveryEnvelope({ reason: 'manual_reconcile' }), deps as never);

    expect((result as { sweep: { outcome: string } }).sweep.outcome).toBe('withheld_ratio');
    expect(deps.markRepositoryRevoked).not.toHaveBeenCalled();
  });

  // @spec EC-30
  it('a transient failure at page 4 of 5 never sweeps: the run fails, sweep_outcome stays not_applicable, zero revoked', async () => {
    const { runInstallationDiscovery } = await loadService();
    const repos = fixture(500);
    const githubClient = makeGithubClient(repos);
    (githubClient.listInstallationReposPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: number, page: number) => {
        if (page === 4) throw new Error('GitHub API request returned 502.');
        const start = (page - 1) * 100;
        return { repos: repos.slice(start, start + 100), page, hasNextPage: page < 5, totalCount: 500 };
      },
    );
    const deps = completeManualReconcileDeps({ githubClient });

    await expect(
      runInstallationDiscovery(discoveryEnvelope({ reason: 'manual_reconcile' }), deps as never),
    ).rejects.toThrow();

    expect(deps.markRepositoryRevoked).not.toHaveBeenCalled();
    expect(deps.recordSweepOutcome).not.toHaveBeenCalled();
    expect(deps.completeInstallationSync).not.toHaveBeenCalled();
  });

  // @spec EC-34
  it('passes the run\'s own startedAt through to listRevokeSweepCandidates as runStartedAt, excluding rows touched after the run began', async () => {
    const { runInstallationDiscovery } = await loadService();
    const startedAt = new Date('2026-08-01T12:00:00Z');
    const listRevokeSweepCandidates = vi.fn(async () => []);
    const deps = completeManualReconcileDeps({
      claimInstallationSync: vi.fn(async () => ({
        nextPage: 1,
        runId: RUN_ID,
        startedAt,
        reason: 'manual_reconcile' as const,
      })),
      listRevokeSweepCandidates,
    });

    await runInstallationDiscovery(discoveryEnvelope({ reason: 'manual_reconcile' }), deps as never);

    expect(listRevokeSweepCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runStartedAt: startedAt }),
    );
  });

  // @spec AC-25 EC-38 (FND-cf76b24c5057 regression)
  it('reason/row MISMATCH: the queue envelope claims manual_reconcile but the row itself (re-read via claimInstallationSync) is app_install — the sweep does not fire, sourced only from the row', async () => {
    const { runInstallationDiscovery } = await loadService();
    const listRevokeSweepCandidates = vi.fn(async () => [{ id: 'repo-x', externalId: '999' }]);
    const markRepositoryRevoked = vi.fn(async () => true);
    const deps = completeManualReconcileDeps({
      // The envelope's own payload.reason says 'manual_reconcile' (discoveryEnvelope below), but
      // the worker-side row read — the ONLY input computeRevokeSweep's authorization guard may
      // use per AC-25/EC-38 — genuinely is 'app_install'. This is the exact gap security's
      // FND-cf76b24c5057 found: prior to the fix, the sweep gated on envelope.payload.reason and
      // would have (incorrectly) swept here; the row must win.
      claimInstallationSync: vi.fn(async () => ({
        nextPage: 1,
        runId: RUN_ID,
        startedAt: new Date('2026-08-01T00:00:00Z'),
        reason: 'app_install' as const,
      })),
      listRevokeSweepCandidates,
      markRepositoryRevoked,
    });

    const result = await runInstallationDiscovery(
      discoveryEnvelope({ reason: 'manual_reconcile' }),
      deps as never,
    );

    expect((result as { sweep: { outcome: string; revoked: number } }).sweep).toEqual({
      outcome: 'not_applicable',
      revoked: 0,
    });
    // The sweep must never even reach the candidate query or a revoke call when the row's own
    // reason disagrees with the envelope's claim.
    expect(listRevokeSweepCandidates).not.toHaveBeenCalled();
    expect(markRepositoryRevoked).not.toHaveBeenCalled();
  });

  // @spec AC-25 EC-38 (FND-cf76b24c5057 regression, inverse direction)
  it('reason/row MISMATCH (inverse): the queue envelope claims app_install but the row itself is manual_reconcile — authorization still follows the row, not the envelope', async () => {
    const { runInstallationDiscovery } = await loadService();
    const listRevokeSweepCandidates = vi.fn(async () => [{ id: 'repo-x', externalId: '999' }]);
    const markRepositoryRevoked = vi.fn(async () => true);
    const deps = completeManualReconcileDeps({
      // Inverse mismatch: the envelope under-claims ('app_install') while the row's real reason
      // is 'manual_reconcile'. Authorization must still be driven purely by the row — a stale or
      // tampered envelope reason must never SUPPRESS a legitimately admin-authorized sweep either;
      // the row is the sole source of truth in both directions.
      claimInstallationSync: vi.fn(async () => ({
        nextPage: 1,
        runId: RUN_ID,
        startedAt: new Date('2026-08-01T00:00:00Z'),
        reason: 'manual_reconcile' as const,
      })),
      listRevokeSweepCandidates,
      markRepositoryRevoked,
    });

    const result = await runInstallationDiscovery(
      discoveryEnvelope({ reason: 'app_install' }),
      deps as never,
    );

    expect((result as { sweep: { outcome: string; revoked: number } }).sweep).toEqual({
      outcome: 'applied',
      revoked: 1,
    });
    expect(listRevokeSweepCandidates).toHaveBeenCalledTimes(1);
    expect(markRepositoryRevoked).toHaveBeenCalledTimes(1);
  });
});

describe('runInstallationDiscovery — AC-26 (audit: exactly one structured sweep log line, no repo text)', () => {
  // @spec AC-26
  it('logs exactly once per sweep, and the log carries no repository name or provider text', async () => {
    const { runInstallationDiscovery } = await loadService();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const deps = makeDeps({
        githubClient: makeGithubClient(fixture(1)),
        listRevokeSweepCandidates: vi.fn(async () => [{ id: 'repo-x', externalId: 'super-secret-repo-name' }]),
        countActiveGithubRepositories: vi.fn(async () => 2),
        // The row's own reason (re-read by the worker) must genuinely be 'manual_reconcile' for
        // the sweep to actually reach 'applied' here, matching the envelope below.
        claimInstallationSync: vi.fn(async () => ({
          nextPage: 1,
          runId: RUN_ID,
          startedAt: new Date('2026-08-01T00:00:00Z'),
          reason: 'manual_reconcile' as const,
        })),
      });

      await runInstallationDiscovery(discoveryEnvelope({ reason: 'manual_reconcile' }), deps as never);

      const sweepLines = logSpy.mock.calls.filter((call) => String(call[0]).includes('sweep'));
      expect(sweepLines).toHaveLength(1);
      expect(sweepLines[0].join(' ')).not.toContain('super-secret-repo-name');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('runInstallationDiscovery — AC-14 (no credential/provider text ever reaches a write or log)', () => {
  // @spec AC-14
  it('a provider failure is recorded with a fixed error code only, never the raw provider message', async () => {
    const { runInstallationDiscovery } = await loadService();
    const githubClient = makeGithubClient(fixture(1));
    (githubClient.listInstallationReposPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('GitHub API request to /installation/repositories?token=ghs_leaked-secret returned 503.'),
    );
    const failInstallationSync = vi.fn(async (input: { errorCode: string }) => {
      expect(['provider_unavailable', 'page_limit_exceeded', 'internal_error']).toContain(input.errorCode);
      expect(JSON.stringify(input)).not.toContain('ghs_leaked-secret');
    });
    const deps = makeDeps({ githubClient, failInstallationSync });

    await expect(runInstallationDiscovery(discoveryEnvelope(), deps as never)).rejects.toThrow();
    expect(failInstallationSync).toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { makeEnvelope } from '../queue/envelope';
import { GitProviderRegistry } from '../integrations/git/providerRegistry';
import { GithubProviderAdapter } from '../integrations/git/providers/github';
import type { OwnershipGraphStore } from '../integrations/git/graphOwnershipStore';
import type { GitRepositoryResolver } from '../integrations/git/repositoryResolver';
import type {
  GitProviderAdapter,
  ProviderChangeSet,
  ProviderRepoEvent,
} from '../integrations/git/types';
import { syncGitMetadata } from './gitSyncService';

// W3-04 gapfill (GAP-7): this file previously imported `FakeHubProviderAdapter` from the
// now-deleted `../integrations/git/__fixtures__/fakehubProvider` (a discard-both-
// arguments stand-in). Every test below is testing syncGitMetadata's own orchestration
// logic against a PRE-DETERMINED ProviderChangeSet, not provider normalization (which
// has its own dedicated coverage in providers/fakehub.test.ts) — so a tiny local stub
// that simply returns whatever ProviderChangeSet it is constructed with replaces the
// deleted shared fixture, preserving every test's original intent without depending on
// the real fakehub adapter's raw-payload normalization rules.
class StaticProviderAdapter implements GitProviderAdapter {
  readonly provider = 'fakehub';
  constructor(private readonly changes: ProviderChangeSet) {}
  async resolveChanges(): Promise<ProviderChangeSet> {
    return this.changes;
  }
}

afterEach(() => {
  resetConfigForTests();
});

describe('syncGitMetadata', () => {
  it('uses server-derived scope and applies a provider-resolved merged-PR edit', async () => {
    const changes = {
      refName: 'refs/heads/main',
      edits: [{
        path: 'src/a.ts',
        commitSha: 'merge-sha',
        commitMessage: 'Merge PR 17',
        editedAt: '2026-07-22T12:00:00Z',
        author: { name: null, email: null, login: 'fake-user' },
        pullRequest: {
          number: 17,
          title: 'Ship it',
          url: 'https://fakehub.test/pr/17',
          mergedAt: '2026-07-22T12:00:00Z',
        },
      }],
    };
    const event: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'pull_request',
      repo: {
        provider_repo_id: 'provider-repo',
        full_name: 'acme/repo',
        repo_id: 'untrusted-payload-repo',
      },
      ref: 'feature',
      installation_id: 'installation',
      delivery_id: 'delivery',
      payload: { action: 'closed' },
    };
    const resolve = vi.fn(async () => ({ repositoryId: 'server-repository-id' }));
    const repositories: GitRepositoryResolver = { resolve };
    const apply = vi.fn(async () => ({ updatedFiles: 1, matchedPaths: ['src/a.ts'] }));
    const graph: OwnershipGraphStore = { apply, close: vi.fn(async () => undefined) };
    const envelope = makeEnvelope({
      org_id: 'server-org-id',
      type: 'repo.pull_request',
      source: 'fakehub-webhook',
      payload: event,
      occurred_at: '2026-07-22T12:00:01Z',
    });

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories,
      graph,
    });

    expect(resolve).toHaveBeenCalledWith('server-org-id', event);
    expect(apply).toHaveBeenCalledWith({
      orgId: 'server-org-id',
      provider: 'fakehub',
      repositoryId: 'server-repository-id',
      refName: 'refs/heads/main',
      edits: changes.edits,
    });
    // W3-04 gapfill (GAP-1b, GAP-2, GAP-5): GitSyncResult grew unmatchedPaths/durationMs/
    // truncated/rebuildRequired — durationMs is a real timing measurement (asserted
    // separately below, not via a fixed literal in this toEqual).
    expect(result).toEqual({
      status: 'applied',
      provider: 'fakehub',
      updatedFiles: 1,
      unmatchedPaths: [],
      durationMs: expect.any(Number),
      truncated: false,
      rebuildRequired: false,
    });
  });

  it('ignores provider events that produce no file changes before database access', async () => {
    const repositories: GitRepositoryResolver = { resolve: vi.fn() };
    const graph: OwnershipGraphStore = {
      apply: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const event: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'branch',
      repo: { provider_repo_id: '1', full_name: 'a/b', repo_id: null },
      ref: 'refs/heads/new',
      installation_id: 'i',
      delivery_id: 'd',
      payload: {},
    };
    const envelope = makeEnvelope({
      org_id: 'server-org-id',
      type: 'repo.branch',
      source: 'fakehub-webhook',
      payload: event,
    });

    await expect(syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([
        new StaticProviderAdapter({ refName: null, edits: [] }),
      ]),
      repositories,
      graph,
    })).resolves.toEqual({
      status: 'ignored',
      provider: 'fakehub',
      updatedFiles: 0,
      unmatchedPaths: [],
      durationMs: expect.any(Number),
      truncated: false,
      rebuildRequired: false,
    });
    expect(repositories.resolve).not.toHaveBeenCalled();
    expect(graph.apply).not.toHaveBeenCalled();
  });

  it('maps a merged GitHub PR to its corresponding File paths end to end', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const event: ProviderRepoEvent = {
      provider: 'github',
      type: 'pull_request',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'feature/widgets',
      installation_id: '99',
      delivery_id: 'delivery-merged',
      payload: {
        action: 'closed',
        number: 21,
        pull_request: {
          merged: true,
          merged_at: '2026-07-22T12:00:00Z',
          merge_commit_sha: 'merge-21',
          title: 'Merge widgets',
          html_url: 'https://github.test/acme/widgets/pull/21',
          head: { ref: 'feature/widgets', sha: 'head-21' },
          base: { ref: 'main', sha: 'base-21' },
          user: { login: 'octocat' },
        },
      },
    };
    const graph: OwnershipGraphStore = {
      apply: vi.fn(async () => ({
        updatedFiles: 2,
        matchedPaths: ['src/api.ts', 'src/widget.ts'],
      })),
      close: vi.fn(async () => undefined),
    };
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'repo.pull_request',
      source: 'github-webhook',
      payload: event,
    });

    // W3-04 gapfill (GAP-3, GAP-8): adapted to the options-object constructor
    // (GithubProviderAdapterOptions) — the two-positional-argument form is gone.
    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([
        new GithubProviderAdapter({
          mintToken: async () => 'ephemeral-token',
          fetcher: async () => new Response(JSON.stringify([
            { filename: 'src/api.ts' },
            { filename: 'src/widget.ts' },
          ]), { status: 200 }),
        }),
      ]),
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    });

    expect(graph.apply).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'server-org',
      provider: 'github',
      repositoryId: 'repo-id',
      refName: 'refs/heads/main',
      edits: [
        expect.objectContaining({ path: 'src/api.ts', pullRequest: expect.objectContaining({ number: 21 }) }),
        expect.objectContaining({ path: 'src/widget.ts', pullRequest: expect.objectContaining({ number: 21 }) }),
      ],
    }));
    expect(result).toEqual({
      status: 'applied',
      provider: 'github',
      updatedFiles: 2,
      unmatchedPaths: [],
      durationMs: expect.any(Number),
      truncated: false,
      rebuildRequired: false,
    });
  });
});

// W3-04 gapfill additions below (GAP-1b, GAP-2, GAP-5). spec.md's Interfaces section adds
// `unmatchedPaths`, `durationMs`, `truncated`, `rebuildRequired` to GitSyncResult and a
// distinct `'unmatched'` status.
describe('syncGitMetadata — W3-04 gapfill', () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100_000 });
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  });

  afterEach(() => {
    metrics.disable();
    resetConfigForTests();
    vi.restoreAllMocks();
  });

  async function metricSum(name: string): Promise<number> {
    await reader.forceFlush();
    const results = exporter.getMetrics();
    let sum = 0;
    for (const resourceMetrics of results) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name !== name) continue;
          for (const point of metric.dataPoints) {
            sum += point.value as number;
          }
        }
      }
    }
    return sum;
  }

  function envelopeFor(event: ProviderRepoEvent, type: string) {
    return makeEnvelope({
      org_id: 'server-org-id',
      type,
      source: 'fakehub-webhook',
      payload: event,
    });
  }

  function mergedPrEvent(edits: Array<{ path: string }>): {
    event: ProviderRepoEvent;
    changes: { refName: string; edits: Array<Record<string, unknown>> };
  } {
    const changes = {
      refName: 'refs/heads/main',
      edits: edits.map(({ path }) => ({
        path,
        commitSha: 'merge-sha',
        commitMessage: 'Merge PR',
        editedAt: '2026-07-22T12:00:00Z',
        author: { name: null, email: null, login: 'fake-user' },
        pullRequest: { number: 1, title: 't', url: null, mergedAt: '2026-07-22T12:00:00Z' },
      })),
    };
    const event: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'pull_request',
      repo: { provider_repo_id: 'provider-repo', full_name: 'acme/repo', repo_id: null },
      ref: 'feature',
      installation_id: 'installation',
      delivery_id: 'delivery',
      payload: { action: 'closed' },
    };
    return { event, changes };
  }

  // @spec AC-4 EC-5
  it("returns status: 'unmatched' (never 'ignored') when the graph matches zero File nodes, naming every unmatched path, and increments git_sync_unmatched_files_total", async () => {
    const { event, changes } = mergedPrEvent([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    const apply = vi.fn(async () => ({ updatedFiles: 0, matchedPaths: [] }));
    const graph: OwnershipGraphStore = { apply, close: vi.fn(async () => undefined) };
    const envelope = envelopeFor(event, 'repo.pull_request');

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    });

    expect(result.status).toBe('unmatched');
    expect(result.unmatchedPaths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(await metricSum('git_sync_unmatched_files_total')).toBeGreaterThanOrEqual(2);
  });

  // @spec AC-4 EC-6
  it("a branch event that legitimately produces no edits still returns status: 'ignored' with empty unmatchedPaths", async () => {
    const repositories: GitRepositoryResolver = { resolve: vi.fn() };
    const graph: OwnershipGraphStore = { apply: vi.fn(), close: vi.fn(async () => undefined) };
    const event: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'branch',
      repo: { provider_repo_id: '1', full_name: 'a/b', repo_id: null },
      ref: 'refs/heads/new',
      installation_id: 'i',
      delivery_id: 'd',
      payload: {},
    };
    const envelope = envelopeFor(event, 'repo.branch');

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new StaticProviderAdapter({ refName: null, edits: [] })]),
      repositories,
      graph,
    });

    expect(result.status).toBe('ignored');
    expect(result.unmatchedPaths).toEqual([]);
  });

  // @spec AC-4 EC-7
  it("a partial match (3 resolved, 2 matched) returns status: 'applied', updatedFiles: 2, and unmatchedPaths naming exactly the third path", async () => {
    const { event, changes } = mergedPrEvent([
      { path: 'src/a.ts' },
      { path: 'src/b.ts' },
      { path: 'src/c.ts' },
    ]);
    const apply = vi.fn(async () => ({
      updatedFiles: 2,
      matchedPaths: ['src/a.ts', 'src/b.ts'],
    }));
    const graph: OwnershipGraphStore = { apply, close: vi.fn(async () => undefined) };
    const envelope = envelopeFor(event, 'repo.pull_request');

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    });

    expect(result.status).toBe('applied');
    expect(result.updatedFiles).toBe(2);
    expect(result.unmatchedPaths).toEqual(['src/c.ts']);
  });

  // @spec AC-5
  it('durationMs carries a monotonic measurement of the whole service call', async () => {
    const { event, changes } = mergedPrEvent([{ path: 'src/a.ts' }]);
    const apply = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { updatedFiles: 1, matchedPaths: ['src/a.ts'] };
    });
    const graph: OwnershipGraphStore = { apply, close: vi.fn(async () => undefined) };
    const envelope = envelopeFor(event, 'repo.pull_request');

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    });

    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(20);
  });

  // @spec AC-5 EC-8
  it('a run that exceeds GIT_SYNC_TARGET_MS still completes and applies the write, and increments git_sync_budget_breach_total', async () => {
    const budgets = await import('../integrations/git/budgets');
    let call = 0;
    // First performance.now() call is the operation's start; every call after
    // returns a fixed instant beyond the budget, so the measured elapsed time
    // deterministically breaches GIT_SYNC_TARGET_MS regardless of how many
    // intermediate calls the implementation makes.
    vi.spyOn(performance, 'now').mockImplementation(() => (call++ === 0 ? 0 : budgets.GIT_SYNC_TARGET_MS + 1_000));

    const { event, changes } = mergedPrEvent([{ path: 'src/a.ts' }]);
    const apply = vi.fn(async () => ({ updatedFiles: 1, matchedPaths: ['src/a.ts'] }));
    const graph: OwnershipGraphStore = { apply, close: vi.fn(async () => undefined) };
    const envelope = envelopeFor(event, 'repo.pull_request');

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    });

    expect(result.status).toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(result.durationMs).toBeGreaterThan(budgets.GIT_SYNC_TARGET_MS);
    expect(await metricSum('git_sync_budget_breach_total')).toBeGreaterThanOrEqual(1);
  });

  // @spec AC-8
  it('surfaces truncated/rebuildRequired from the provider ChangeSet on GitSyncResult and increments git_sync_push_truncated_total', async () => {
    const changes = { refName: 'refs/heads/main', edits: [], truncated: true, rebuildRequired: true };
    const event: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'push',
      repo: { provider_repo_id: '1', full_name: 'a/b', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: 'i',
      delivery_id: 'd',
      payload: {},
    };
    const envelope = envelopeFor(event, 'repo.push');
    const graph: OwnershipGraphStore = { apply: vi.fn(), close: vi.fn(async () => undefined) };

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: { resolve: vi.fn() },
      graph,
    });

    expect(result.truncated).toBe(true);
    expect(result.rebuildRequired).toBe(true);
    expect(await metricSum('git_sync_push_truncated_total')).toBeGreaterThanOrEqual(1);
  });

  // EC-15 ("GitRepositoryNotRegisteredError still fails the job — it must not be
  // swallowed into a false 'ignored'") is NOT authored here: syncGitMetadata already
  // propagates a thrown resolve() error today (there is no try/catch around it), so a
  // unit test at this layer would pass now and demonstrate nothing. EC-15's actual
  // gap is end-to-end — that a GAP-4 retry-wrapping implementation around the BullMQ
  // job must not introduce swallowing that doesn't exist today — and is covered as a
  // genuinely-new, currently-unwritten assertion in
  // integrations/git/__tests__/jobRetry.integration.test.ts (RED-DEFERRED, needs Redis).
});

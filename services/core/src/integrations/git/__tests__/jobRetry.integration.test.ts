// W3-04 gapfill (GAP-4). Real BullMQ + Redis proof of the retry/backoff/terminal-failure
// policy spec.md pins as GIT_SYNC_JOB_OPTIONS (attempts: 5, exponential backoff,
// removeOnFail: false) plus the worker's `failed` listener (AC-7, EC-13, EC-14, EC-15).
//
// gitSyncService.test.ts deliberately does NOT author a unit-level EC-15 test: a thrown
// GitRepositoryNotRegisteredError already propagates out of syncGitMetadata today (no
// try/catch wraps that call), so a fake-dependency unit test would pass now and prove
// nothing about GAP-4's actual risk — that a retry-wrapping implementation introduces
// swallowing that doesn't exist today. This file is the real, currently-nonexistent
// end-to-end proof: with GIT_SYNC_JOB_OPTIONS wired in, does the job genuinely still
// fail (and stay in `failed`, not get silently retried into a false success)?
//
// INTEGRATION test: requires Redis reachable at REDIS_HOST/REDIS_PORT. Skips locally
// when unreachable; CI sets MESSAGING_INTEGRATION_REQUIRED=true, which turns an
// unreachable broker into a hard failure, following
// src/queue/__tests__/bullmq.roundtrip.test.ts:216's exact pattern. Does NOT require
// Neo4j: `graph`/`repositories` are injected fakes via startGitSyncWorker's overrides.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IORedis from 'ioredis';
import { getConfig, getSecret, SecretNotFoundError, resetConfigForTests } from '@sayre/config';
import { makeEnvelope } from '../../../queue/envelope';
import { enqueue, closeQueues, getQueue } from '../../../queue/bullmq';
import { startGitSyncWorker } from '../worker';
import { GitProviderRegistry } from '../providerRegistry';
import { GitRepositoryNotRegisteredError } from '../repositoryResolver';
import type { OwnershipGraphStore } from '../graphOwnershipStore';
import type { GitProviderAdapter, ProviderChangeSet, ProviderRepoEvent } from '../types';

// W3-04 gapfill (GAP-7): this file previously imported `FakeHubProviderAdapter` from the
// now-deleted `../__fixtures__/fakehubProvider` (a discard-both-arguments stand-in). The
// three tests below drive GAP-4's retry/backoff/terminal-failure policy through a
// PRE-DETERMINED ProviderChangeSet, not provider normalization — so a tiny local stub
// replaces the deleted shared fixture, unchanged in behavior.
class StaticProviderAdapter implements GitProviderAdapter {
  readonly provider = 'fakehub';
  constructor(private readonly changes: ProviderChangeSet) {}
  async resolveChanges(): Promise<ProviderChangeSet> {
    return this.changes;
  }
}

async function redisReachable(): Promise<boolean> {
  let password: string | undefined;
  try {
    password = await getSecret('env://REDIS_PASSWORD');
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
  }
  const conn = new IORedis({
    host: getConfig('REDIS_HOST'),
    port: Number(getConfig('REDIS_PORT')),
    password,
    maxRetriesPerRequest: 0,
    connectTimeout: 2000,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  conn.on('error', () => {});
  try {
    await conn.connect();
    await conn.ping();
    return true;
  } catch {
    return false;
  } finally {
    conn.disconnect();
  }
}

const brokerRequired = getConfig('MESSAGING_INTEGRATION_REQUIRED') === 'true';
const brokerUp = await redisReachable();
if (!brokerUp) {
  const endpoint = `${getConfig('REDIS_HOST')}:${getConfig('REDIS_PORT')}`;
  if (brokerRequired) {
    throw new Error(`[jobRetry.integration] Redis is required but unreachable at ${endpoint}.`);
  }
  // eslint-disable-next-line no-console
  console.warn(`[jobRetry.integration] Redis unreachable at ${endpoint} — skipping GAP-4 retry tests.`);
}

function pushEvent(): ProviderRepoEvent {
  return {
    provider: 'fakehub',
    type: 'push',
    repo: { provider_repo_id: 'fake-1', full_name: 'acme/repo', repo_id: null },
    ref: 'refs/heads/main',
    installation_id: 'fake-installation',
    delivery_id: `delivery-${randomUUID()}`,
    payload: {},
  };
}

describe.skipIf(!brokerUp)('github-sync job retry policy against real BullMQ + Redis (GAP-4)', () => {
  afterEach(async () => {
    resetConfigForTests();
    await closeQueues();
  });

  // @spec AC-7 EC-13
  it('a transient graph failure on attempt 1 followed by success on attempt 2 ends with the write applied exactly once', async () => {
    let calls = 0;
    const apply = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient graph failure');
      return { updatedFiles: 1, matchedPaths: ['src/a.ts'] };
    });
    const graph: OwnershipGraphStore = { apply, close: vi.fn(async () => undefined) };

    const changes = {
      refName: 'refs/heads/main',
      edits: [
        {
          path: 'src/a.ts',
          commitSha: 'commit-1',
          commitMessage: 'change',
          editedAt: new Date().toISOString(),
          author: { name: 'Ada', email: 'ada@example.test', login: 'ada' },
          pullRequest: null,
        },
      ],
    };

    const runtime = await startGitSyncWorker({
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    } as never);

    try {
      const envelope = makeEnvelope({
        org_id: `org-${randomUUID()}`,
        type: 'repo.push',
        source: 'fakehub-webhook',
        payload: pushEvent(),
      });
      const { GIT_SYNC_JOB_OPTIONS } = await import('../jobPolicy');
      await enqueue('github-sync', envelope, GIT_SYNC_JOB_OPTIONS);

      // Give BullMQ's exponential backoff (1s base delay) room to retry once.
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      expect(apply).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  }, 15_000);

  // @spec AC-7 EC-14
  it('a job that exhausts every attempt stays in the failed set (not removed) and the failure carries no payload/token', async () => {
    const graph: OwnershipGraphStore = {
      apply: vi.fn(async () => {
        throw new Error('permanent graph failure');
      }),
      close: vi.fn(async () => undefined),
    };
    const changes = {
      refName: 'refs/heads/main',
      edits: [
        {
          path: 'src/a.ts',
          commitSha: 'commit-1',
          commitMessage: 'change',
          editedAt: new Date().toISOString(),
          author: { name: 'Ada', email: 'ada@example.test', login: 'ada' },
          pullRequest: null,
        },
      ],
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const runtime = await startGitSyncWorker({
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    } as never);

    try {
      const envelope = makeEnvelope({
        org_id: `org-${randomUUID()}`,
        type: 'repo.push',
        source: 'fakehub-webhook',
        payload: pushEvent(),
      });
      const { GIT_SYNC_JOB_OPTIONS } = await import('../jobPolicy');
      // Cap attempts at 2 (not the full 5) so this test doesn't wait through the whole
      // exponential backoff schedule — still exercises "exhausted -> stays in failed".
      const jobId = await enqueue('github-sync', envelope, { ...GIT_SYNC_JOB_OPTIONS, attempts: 2 });

      await new Promise((resolve) => setTimeout(resolve, 3_000));

      const queue = await getQueue('github-sync');
      const failedJob = await queue.getJob(jobId);
      expect(failedJob).toBeDefined();
      const state = await failedJob!.getState();
      expect(state).toBe('failed');

      const loggedText = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join('\n');
      expect(loggedText).not.toContain(JSON.stringify(envelope.payload));
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await runtime.close();
    }
  }, 15_000);

  // @spec EC-15
  it('GitRepositoryNotRegisteredError still fails the job end to end — it must not be swallowed into a false completion', async () => {
    const graph: OwnershipGraphStore = { apply: vi.fn(), close: vi.fn(async () => undefined) };
    const changes = {
      refName: 'refs/heads/main',
      edits: [
        {
          path: 'src/a.ts',
          commitSha: 'commit-1',
          commitMessage: 'change',
          editedAt: new Date().toISOString(),
          author: { name: 'Ada', email: 'ada@example.test', login: 'ada' },
          pullRequest: null,
        },
      ],
    };

    const runtime = await startGitSyncWorker({
      providers: new GitProviderRegistry([new StaticProviderAdapter(changes)]),
      repositories: {
        resolve: async () => {
          throw new GitRepositoryNotRegisteredError('fakehub', 'fake-1');
        },
      },
      graph,
    } as never);

    try {
      const envelope = makeEnvelope({
        org_id: `org-${randomUUID()}`,
        type: 'repo.push',
        source: 'fakehub-webhook',
        payload: pushEvent(),
      });
      const { GIT_SYNC_JOB_OPTIONS } = await import('../jobPolicy');
      const jobId = await enqueue('github-sync', envelope, { ...GIT_SYNC_JOB_OPTIONS, attempts: 1 });

      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const queue = await getQueue('github-sync');
      const job = await queue.getJob(jobId);
      const state = await job!.getState();
      expect(state).toBe('failed');
      expect(graph.apply).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  }, 15_000);
});

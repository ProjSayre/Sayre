// BullMQ enqueue -> worker round-trip against the shared local Redis.
//
// Acceptance criterion 2 (Node round-trip) plus the BullMQ edge cases: a job whose
// data fails assertValidEnvelope moves to `failed` (attempts: 1) and never reaches
// the handler body; enqueue rejects an envelope with an empty org_id and adds nothing.
//
// INTEGRATION test: requires Redis reachable at REDIS_HOST/REDIS_PORT. When Redis is
// unreachable the whole describe SKIPS (never fails) so `npm run test` still passes
// without infra (spec edge case "LocalStack or Redis not running -> tests skip").

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import IORedis from 'ioredis';
import type { Worker, Job } from 'bullmq';
import { makeEnvelope, MessageEnvelope, EnvelopeValidationError } from '../envelope';
import {
  enqueue,
  createWorker,
  getQueue,
  closeQueues,
  QUEUE_NAMES,
  type GithubSyncPayload,
} from '../bullmq';

// Broker-independent surface checks (always run).
describe('bullmq surface', () => {
  it('AC3/AC6: exposes exactly the three integration queues, no more', () => {
    expect([...QUEUE_NAMES]).toEqual(['github-sync', 'jira-sync', 'linear-sync']);
  });

  it('AC6: a new git provider is a `provider` value on github-sync, not a new queue', () => {
    // cursor-origin joins the EXISTING github-sync queue as a provider-keyed job type.
    const env = makeEnvelope<GithubSyncPayload>({
      org_id: 'org_1',
      type: 'github.push',
      source: 'cursor-origin-webhook',
      payload: {
        provider: 'cursor-origin',
        event: 'push',
        installation_id: 'i',
        repo_full_name: 'a/b',
        delivery_id: 'd',
      },
    });
    expect(env.payload.provider).toBe('cursor-origin');
    expect([...QUEUE_NAMES]).not.toContain('cursor-origin-sync');
  });
});

async function redisReachable(): Promise<boolean> {
  const conn = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 0,
    connectTimeout: 2000,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  // Swallow the ECONNREFUSED 'error' event so a down-broker probe skips quietly.
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

const brokerUp = await redisReachable();
if (!brokerUp) {
  // eslint-disable-next-line no-console
  console.warn(
    `[bullmq.roundtrip] Redis unreachable at ${process.env.REDIS_HOST || 'localhost'}:${
      process.env.REDIS_PORT || '6379'
    } — skipping BullMQ integration round-trip tests.`,
  );
}

describe.skipIf(!brokerUp)('BullMQ round-trip (needs Redis)', () => {
  const workers: Worker[] = [];

  beforeAll(async () => {
    // Clear any leftovers from a prior run before any worker is attached.
    await getQueue('github-sync').obliterate({ force: true });
  });

  afterEach(async () => {
    while (workers.length) {
      const w = workers.pop()!;
      await w.close();
    }
  });

  afterAll(async () => {
    try {
      await getQueue('github-sync').obliterate({ force: true });
    } catch {
      // ignore teardown errors
    }
    await closeQueues();
  });

  it('AC2: enqueue -> worker processes; handler sees same org_id / typed payload', async () => {
    const env = makeEnvelope<GithubSyncPayload>({
      org_id: 'org_gh_1',
      type: 'github.push',
      source: 'github-webhook',
      payload: {
        provider: 'github',
        event: 'push',
        installation_id: 'inst-42',
        repo_full_name: 'acme/widgets',
        delivery_id: 'dlv-1',
      },
    });

    const processed = new Promise<MessageEnvelope<GithubSyncPayload>>((resolve, reject) => {
      const w = createWorker('github-sync', async (envelope) => {
        if (envelope.message_id === env.message_id) {
          resolve(envelope);
        }
      });
      workers.push(w);
      w.on('error', reject);
    });

    const jobId = await enqueue('github-sync', env);
    expect(jobId).toBeTruthy();

    const got = await processed;
    expect(got.org_id).toBe('org_gh_1');
    // Exercises GithubSyncPayload typing at compile time as well as runtime.
    expect(got.payload.provider).toBe('github');
    expect(got.payload.repo_full_name).toBe('acme/widgets');
    expect(got.payload.delivery_id).toBe('dlv-1');
  });

  it('invalid job.data fails the job (attempts:1) and never runs the handler body', async () => {
    let handlerRan = false;

    const failure = new Promise<{ job?: Job; err: Error }>((resolve) => {
      const w = createWorker('github-sync', async () => {
        handlerRan = true;
      });
      workers.push(w);
      w.on('failed', (job, err) => resolve({ job, err }));
    });

    // Bypass enqueue()'s validation to inject data that would come off the wire
    // without ever having passed through makeEnvelope/enqueue.
    await getQueue('github-sync').add(
      'bogus',
      { not: 'an envelope' } as unknown as MessageEnvelope<GithubSyncPayload>,
      { attempts: 1, removeOnComplete: false, removeOnFail: false },
    );

    const { err } = await failure;
    expect(handlerRan).toBe(false);
    expect(
      err.name === 'EnvelopeValidationError' || /Envelope/.test(err.message),
    ).toBe(true);
  });

  it('enqueue rejects an envelope with empty org_id and adds nothing', async () => {
    const queue = getQueue('github-sync');
    const before = await queue.getWaitingCount();

    const bad = {
      message_id: randomUUID(),
      org_id: '', // empty tenant context -> must be rejected before add
      type: 'github.push',
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      source: 'github-webhook',
      trace_id: null,
      payload: {
        provider: 'github',
        event: 'push',
        installation_id: 'i',
        repo_full_name: 'a/b',
        delivery_id: 'd',
      },
    } as MessageEnvelope<GithubSyncPayload>;

    await expect(enqueue('github-sync', bad)).rejects.toBeInstanceOf(
      EnvelopeValidationError,
    );

    const after = await queue.getWaitingCount();
    expect(after).toBe(before);
  });
});

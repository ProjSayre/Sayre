// W0-04 (GAP-3a, GAP-5) — BullMQ lane priority against a LIVE Redis broker.
//
// Canonical acceptance line: docs/product/Ticket-Backlog-by-Feature-2.md §W0-04 —
// "a priority message demonstrably drains ahead of a backlog of default messages".
// docs/backlog.md's reword (two same-language round-trips, no priority clause) is
// superseded and is NOT what this file measures.
//
// Why this file cannot be a unit test: BullMQ 5.28 keeps unprioritized jobs in the
// `wait` list and prioritized jobs in a separate `prioritized` zset, and
// moveToActive drains `wait` COMPLETELY before it ever looks at `prioritized`
// (commands/moveToActive-11.lua). Only a live broker can show (a) that no job
// enqueue() adds lands in `wait`, and (b) that a priority-lane job is dequeued ahead
// of an already-enqueued default backlog. A mocked queue.add cannot prove either —
// see bullmq.lane.test.ts for the mapping-logic half of the same mechanism.
//
// INTEGRATION test: requires Redis reachable at REDIS_HOST/REDIS_PORT. When Redis is
// unreachable the whole describe skips for ordinary local runs. CI sets
// MESSAGING_INTEGRATION_REQUIRED=true, which turns an unavailable broker into a hard
// failure rather than silently losing integration coverage (EC-12).

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import IORedis from 'ioredis';
import type { Worker } from 'bullmq';
import { getConfig, getSecret, SecretNotFoundError } from '@sayre/config';
import { EnvelopeValidationError, makeEnvelope, type MessageEnvelope } from '../envelope';
import {
  closeQueues,
  createWorker,
  enqueue,
  getQueue,
  type GithubSyncPayload,
  type QueueName,
} from '../bullmq';

const QUEUE: QueueName = 'github-sync';
const DEFAULT_BACKLOG = 20;

// `enqueue`'s option type widens from JobsOptions to EnqueueOptions in this ticket;
// deriving it from the function keeps this file compiling on both sides of that change.
type EnqueueOpts = NonNullable<Parameters<typeof enqueue>[2]>;

function lane(name: string): EnqueueOpts {
  return { lane: name } as unknown as EnqueueOpts;
}

function envelope(key: string): MessageEnvelope<GithubSyncPayload> {
  return makeEnvelope<GithubSyncPayload>({
    org_id: 'org_priority_test',
    type: 'repo.push',
    source: 'github-webhook',
    idempotency_key: key,
    payload: {
      provider: 'github',
      type: 'push',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: 'inst-42',
      delivery_id: key,
      payload: {},
    },
  });
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

const brokerRequired = getConfig('MESSAGING_INTEGRATION_REQUIRED') === 'true';
const brokerUp = await redisReachable();
if (!brokerUp) {
  const endpoint = `${getConfig('REDIS_HOST')}:${getConfig('REDIS_PORT')}`;
  if (brokerRequired) {
    throw new Error(`[bullmq.priority] Redis is required but unreachable at ${endpoint}.`);
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[bullmq.priority] Redis unreachable at ${endpoint} — skipping BullMQ lane priority tests.`,
  );
}

describe.skipIf(!brokerUp)('BullMQ lane priority drain (needs Redis)', () => {
  const workers: Worker[] = [];

  /**
   * Attaches the worker only AFTER the caller has finished enqueueing (EC-7) and runs
   * it at concurrency 1, so the observed handler order is the broker's dequeue order.
   */
  async function processInOrder(expected: number): Promise<string[]> {
    const processed: string[] = [];
    let resolveDone!: () => void;
    let rejectDone!: (reason: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const worker = await createWorker(
      QUEUE,
      async (received) => {
        processed.push(received.idempotency_key);
        if (processed.length >= expected) resolveDone();
      },
      { concurrency: 1 },
    );
    workers.push(worker);
    worker.on('error', (error) => rejectDone(error));
    worker.on('failed', (_job, error) => rejectDone(error));

    await done;
    return processed;
  }

  beforeAll(async () => {
    await (await getQueue(QUEUE)).obliterate({ force: true });
  });

  afterEach(async () => {
    while (workers.length) {
      const worker = workers.pop()!;
      await worker.close();
    }
    await (await getQueue(QUEUE)).obliterate({ force: true });
  });

  afterAll(async () => {
    await Promise.allSettled([(await getQueue(QUEUE)).obliterate({ force: true })]);
    await closeQueues();
  });

  // @spec AC-2
  it('AC-2: every enqueued job lands in `prioritized`, never in the unprioritized `wait` list', async () => {
    const queue = await getQueue(QUEUE);
    const run = randomUUID();

    for (let index = 0; index < DEFAULT_BACKLOG; index += 1) {
      await enqueue(QUEUE, envelope(`default-${run}-${index}`));
    }
    await enqueue(QUEUE, envelope(`priority-${run}`), lane('priority'));

    // The load-bearing assertion of this ticket: a job with a falsy priority would sit
    // in `wait`, which moveToActive drains BEFORE `prioritized`. A regression to
    // `priority: 0` (or to omitting priority on the default lane) shows up here as a
    // non-zero waiting count, even though every job would still eventually run.
    expect(await queue.getWaitingCount()).toBe(0);
    expect(await queue.getPrioritizedCount()).toBe(DEFAULT_BACKLOG + 1);
  });

  // @spec AC-4 EC-7 EC-2
  it('AC-4: a priority-lane job enqueued LAST is processed FIRST, ahead of a 20-job default backlog', async () => {
    const queue = await getQueue(QUEUE);
    const run = randomUUID();
    const backlog: string[] = [];

    for (let index = 0; index < DEFAULT_BACKLOG; index += 1) {
      const key = `default-${run}-${index}`;
      backlog.push(key);
      await enqueue(QUEUE, envelope(key));
    }
    const priorityKey = `priority-${run}`;
    await enqueue(QUEUE, envelope(priorityKey), lane('priority'));

    // EC-7: nothing may have been consumed before the worker exists, or the ordering
    // assertion below would be meaningless.
    expect(await queue.getPrioritizedCount()).toBe(DEFAULT_BACKLOG + 1);

    const processed = await processInOrder(DEFAULT_BACKLOG + 1);

    expect(processed[0]).toBe(priorityKey);
    expect(processed).toHaveLength(DEFAULT_BACKLOG + 1);
    expect(new Set(processed)).toEqual(new Set([...backlog, priorityKey]));
    // EC-2: lane priority must not reorder same-lane work.
    expect(processed.filter((key) => key.startsWith('default-'))).toEqual(backlog);
  });

  // @spec EC-2
  it('EC-2: FIFO is preserved within each lane — two priority jobs, then two default jobs, all in enqueue order', async () => {
    const run = randomUUID();
    const priorityKeys = [`priority-${run}-0`, `priority-${run}-1`];
    const defaultKeys = [`default-${run}-0`, `default-${run}-1`];

    for (const key of defaultKeys) {
      await enqueue(QUEUE, envelope(key));
    }
    for (const key of priorityKeys) {
      await enqueue(QUEUE, envelope(key), lane('priority'));
    }

    const processed = await processInOrder(4);

    expect(processed).toEqual([...priorityKeys, ...defaultKeys]);
  });

  // @spec EC-5
  it('EC-5: a rejected envelope adds nothing — counted with getPrioritizedCount, which getWaitingCount can no longer see', async () => {
    const queue = await getQueue(QUEUE);
    await enqueue(QUEUE, envelope(`default-${randomUUID()}`));

    const before = await queue.getPrioritizedCount();
    expect(before).toBe(1);
    // getWaitingCount() is structurally 0 for every lane now, so a before/after
    // comparison on it would be vacuous rather than protective.
    expect(await queue.getWaitingCount()).toBe(0);

    const bad = { ...envelope(`rejected-${randomUUID()}`), org_id: '' };
    await expect(enqueue(QUEUE, bad, lane('priority'))).rejects.toBeInstanceOf(
      EnvelopeValidationError,
    );

    expect(await queue.getPrioritizedCount()).toBe(before);
    expect(await queue.getWaitingCount()).toBe(0);
  });
});

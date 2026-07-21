// BullMQ enqueue -> worker round-trip against the shared local Redis.
//
// Acceptance criterion 9 (Node round-trip) plus the BullMQ edge cases: a job whose
// data fails assertValidEnvelope moves to `failed` (attempts: 1) and never reaches
// the handler body; enqueue rejects an envelope with an empty org_id and adds nothing.
//
// INTEGRATION test: requires Redis reachable at REDIS_HOST/REDIS_PORT. When Redis is
// unreachable the whole describe skips for ordinary local runs. CI sets
// MESSAGING_INTEGRATION_REQUIRED=true, which turns an unavailable broker into a hard
// failure rather than silently losing integration coverage.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import IORedis from 'ioredis';
import type { Worker, Job } from 'bullmq';
import {
  getConfig,
  getSecret,
  EmptySecretError,
  resetConfigForTests,
  resetSecretsForTests,
  SecretNotFoundError,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import { makeEnvelope, MessageEnvelope, EnvelopeValidationError } from '../envelope';
import { createPoolFromSecret } from '../../db/client';
import {
  enqueue,
  createWorker,
  getQueue,
  closeQueues,
  createRedisConnection,
  QUEUE_NAMES,
  type GithubSyncPayload,
  type JiraSyncPayload,
  type LinearSyncPayload,
  type QueueName,
  type QueuePayloads,
} from '../bullmq';

// Broker-independent surface checks (always run).
describe('bullmq surface', () => {
  it('AC3/AC6: exposes exactly the three integration queues, no more', () => {
    expect([...QUEUE_NAMES]).toEqual(['github-sync', 'jira-sync', 'linear-sync']);
  });

  it('resolves config and secret values before invoking a network-free Redis factory', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'redis.internal');
    setConfigOverrideForTests('REDIS_PORT', '6380');
    setSecretBackendForTests(async () => 'resolved-redis-password');
    let received: Record<string, unknown> | undefined;
    const fakeConnection = { kind: 'fake-redis' };

    try {
      const result = await createRedisConnection((options) => {
        received = options as unknown as Record<string, unknown>;
        return fakeConnection as unknown as IORedis;
      });
      expect(result).toBe(fakeConnection);
      expect(received).toMatchObject({
        host: 'redis.internal',
        port: 6380,
        password: 'resolved-redis-password',
        maxRetriesPerRequest: null,
      });
    } finally {
      resetConfigForTests();
      resetSecretsForTests();
    }
  });

  it('rejects an explicitly empty environment password before Redis construction', async () => {
    vi.stubEnv('REDIS_PASSWORD', '   ');
    resetSecretsForTests();
    const factory = vi.fn(() => ({ kind: 'must-not-construct' }) as unknown as IORedis);
    try {
      await expect(createRedisConnection(factory)).rejects.toBeInstanceOf(EmptySecretError);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      resetSecretsForTests();
    }
  });

  it('rejects an explicitly empty backend password before Redis construction', async () => {
    setSecretBackendForTests(async () => '   ');
    const factory = vi.fn(() => ({ kind: 'must-not-construct' }) as unknown as IORedis);
    try {
      await expect(createRedisConnection(factory)).rejects.toBeInstanceOf(EmptySecretError);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      resetSecretsForTests();
    }
  });

  it('allows a genuinely missing password to select the local no-auth fallback', async () => {
    setSecretBackendForTests(async () => {
      throw new SecretNotFoundError('untrusted-backend-name');
    });
    const fakeConnection = { kind: 'fake-no-auth-redis' };
    const factory = vi.fn(() => fakeConnection as unknown as IORedis);
    try {
      await expect(createRedisConnection(factory)).resolves.toBe(fakeConnection);
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ password: undefined, maxRetriesPerRequest: null }),
      );
    } finally {
      resetSecretsForTests();
    }
  });

  it('defaults network-free runtime pools to the non-admin database reference', async () => {
    const references: string[] = [];
    setSecretBackendForTests(async (ref) => {
      references.push(ref);
      return 'postgresql://resolved.invalid/sayre';
    });
    try {
      const pool = await createPoolFromSecret();
      expect(references).toEqual(['env://DATABASE_RUNTIME_URL']);
      expect(pool.options.connectionString).toBe('postgresql://resolved.invalid/sayre');
      await pool.end();
    } finally {
      resetSecretsForTests();
    }
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
    throw new Error(
      `[bullmq.roundtrip] Redis is required but unreachable at ${endpoint}.`,
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[bullmq.roundtrip] Redis unreachable at ${endpoint} — skipping BullMQ integration round-trip tests.`,
  );
}

describe.skipIf(!brokerUp)('BullMQ round-trip (needs Redis)', () => {
  const workers: Worker[] = [];

  async function assertRoundTrip<Q extends QueueName>(
    queueName: Q,
    envelope: MessageEnvelope<QueuePayloads[Q]>,
    assertPayload: (payload: QueuePayloads[Q]) => void,
  ): Promise<void> {
    let resolveProcessed!: (value: MessageEnvelope<QueuePayloads[Q]>) => void;
    let rejectProcessed!: (reason: unknown) => void;
    const processed = new Promise<MessageEnvelope<QueuePayloads[Q]>>((resolve, reject) => {
      resolveProcessed = resolve;
      rejectProcessed = reject;
    });

    let resolveCompleted!: (value: { jobId: string; result: unknown }) => void;
    let rejectCompleted!: (reason: unknown) => void;
    const completed = new Promise<{ jobId: string; result: unknown }>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    const worker = await createWorker(queueName, async (received) => {
      if (received.message_id === envelope.message_id) resolveProcessed(received);
    });
    workers.push(worker);
    worker.on('completed', (job, result) => {
      if ((job.data as MessageEnvelope).message_id === envelope.message_id) {
        resolveCompleted({ jobId: job.id ?? '', result });
      }
    });
    worker.on('error', (error) => {
      rejectProcessed(error);
      rejectCompleted(error);
    });

    const jobId = await enqueue(queueName, envelope, { removeOnComplete: false });
    expect(jobId).toBeTruthy();

    const [received, completion] = await Promise.all([processed, completed]);
    expect(received.org_id).toBe(envelope.org_id);
    expect(received.idempotency_key).toBe(envelope.idempotency_key);
    assertPayload(received.payload);
    expect(completion.jobId).toBe(jobId);
    // createWorker intentionally exposes a Promise<void> handler today. Observing the
    // completed event (including its result) proves BullMQ committed each job.
    expect(completion).toHaveProperty('result');
  }

  beforeAll(async () => {
    // Clear any leftovers from a prior run before any worker is attached.
    await Promise.all(
      QUEUE_NAMES.map(async (queueName) =>
        (await getQueue(queueName)).obliterate({ force: true }),
      ),
    );
  });

  afterEach(async () => {
    while (workers.length) {
      const w = workers.pop()!;
      await w.close();
    }
  });

  afterAll(async () => {
    await Promise.allSettled(
      QUEUE_NAMES.map(async (queueName) =>
        (await getQueue(queueName)).obliterate({ force: true }),
      ),
    );
    await closeQueues();
  });

  it('AC9: all three physical queues process typed jobs to completion', async () => {
    const queues = await Promise.all(QUEUE_NAMES.map((queueName) => getQueue(queueName)));
    expect(new Set(queues.map((queue) => queue.name)).size).toBe(3);
    expect(new Set(queues.map((queue) => queue.toKey('wait'))).size).toBe(3);

    const github = makeEnvelope<GithubSyncPayload>({
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
    const jira = makeEnvelope<JiraSyncPayload>({
      org_id: 'org_jira_1',
      type: 'jira.issue.updated',
      source: 'jira-webhook',
      payload: {
        site_id: 'site-42',
        event: 'issue_updated',
        issue_key: 'SAY-104',
      },
    });
    const linear = makeEnvelope<LinearSyncPayload>({
      org_id: 'org_linear_1',
      type: 'linear.issue.updated',
      source: 'linear-webhook',
      payload: {
        workspace_id: 'workspace-42',
        event: 'issue_updated',
        issue_id: 'linear-104',
      },
    });

    await Promise.all([
      assertRoundTrip('github-sync', github, (payload) => {
        expect(payload.provider).toBe('github');
        expect(payload.repo_full_name).toBe('acme/widgets');
        expect(payload.delivery_id).toBe('dlv-1');
      }),
      assertRoundTrip('jira-sync', jira, (payload) => {
        expect(payload.site_id).toBe('site-42');
        expect(payload.issue_key).toBe('SAY-104');
      }),
      assertRoundTrip('linear-sync', linear, (payload) => {
        expect(payload.workspace_id).toBe('workspace-42');
        expect(payload.issue_id).toBe('linear-104');
      }),
    ]);
  });

  it('invalid job.data fails the job (attempts:1) and never runs the handler body', async () => {
    let handlerRan = false;

    let resolveFailure!: (value: { job?: Job; err: Error }) => void;
    const failure = new Promise<{ job?: Job; err: Error }>((resolve) => {
      resolveFailure = resolve;
    });
    const worker = await createWorker('github-sync', async () => {
      handlerRan = true;
    });
    workers.push(worker);
    worker.on('failed', (job, err) => resolveFailure({ job, err }));

    // Bypass enqueue()'s validation to inject data that would come off the wire
    // without ever having passed through makeEnvelope/enqueue.
    await (await getQueue('github-sync')).add(
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
    const queue = await getQueue('github-sync');
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

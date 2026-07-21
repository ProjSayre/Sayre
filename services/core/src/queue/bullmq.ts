// BullMQ wrapper for Node integration workers (GitHub/Jira/Linear).
//
// Permanent split (`.claude/rules/async-messaging.md`): BullMQ backs Node integration
// workers; SQS backs the Python worker fleet (`services/workers/queue/sqs_client.py`).
// Do not add an SQS client here, and do not add a new queue for a new integration —
// a new git provider (e.g. Cursor Origin, PRD §6) is a new JOB TYPE / `provider` value
// on the existing `github-sync` queue, not a new queue.
//
// Webhook-trust invariant (`.claude/rules/security-multitenancy.md`): callers that
// originate from a webhook MUST HMAC/signature-validate the payload and resolve
// `org_id` server-side (from the installation/account -> org mapping in Postgres)
// BEFORE calling `enqueue()`. Never copy `org_id` from the webhook body. This module
// enforces the envelope shape (org_id required, checked by `assertValidEnvelope` on
// both enqueue and consume); it does not implement webhook receivers (out of scope
// for this ticket).

import { Queue, Worker, Job, JobsOptions, WorkerOptions } from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import { getConfig, getSecret, SecretNotFoundError } from '@sayre/config';
import type { NormalizedRepoEvent } from '@sayre/shared-types';
import { MessageEnvelope, assertValidEnvelope } from './envelope';

// One queue per integration (locked by ticket). This set is closed at the QUEUE level; a NEW
// git provider (e.g. Cursor Origin, PRD §6) is added as a new JOB TYPE / provider on the
// existing github-sync queue — NOT a new queue — per .claude/rules/async-messaging.md.
export const QUEUE_NAMES = ['github-sync', 'jira-sync', 'linear-sync'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// W1-02: `github-sync` now carries the single provider-generic `NormalizedRepoEvent`
// schema shared with the SQS ingestion queue (see services/core/src/queue/sqs.ts and
// packages/shared-types) rather than a BullMQ-only shape — W1-02 spec.md O-2. The
// `GithubSyncPayload` name is kept as a back-compat alias so existing type imports
// don't break.
export type GithubSyncPayload = NormalizedRepoEvent;

// Typed job payloads (skeletons — integration tickets extend these).
export interface JiraSyncPayload {
  site_id: string;
  event: string;
  issue_key?: string;
}
export interface LinearSyncPayload {
  workspace_id: string;
  event: string;
  issue_id?: string;
}

export interface QueuePayloads {
  'github-sync': GithubSyncPayload;
  'jira-sync': JiraSyncPayload;
  'linear-sync': LinearSyncPayload;
}

let redisConnection: IORedis | null = null;
let redisConnectionPending: Promise<IORedis> | null = null;
const queues = new Map<QueueName, Queue>();
const queuePending = new Map<QueueName, Promise<Queue>>();
let lifecycleGeneration = 0;
let closePending: Promise<void> | null = null;

export class QueueInitializationCancelledError extends Error {
  constructor() {
    super('Queue initialization was cancelled by shutdown.');
    this.name = 'QueueInitializationCancelledError';
  }
}

export type RedisConnectionFactory = (options: RedisOptions) => IORedis;

/** Resolve every setting before handing options to the client constructor. */
export async function createRedisConnection(
  factory: RedisConnectionFactory = (options) => new IORedis(options),
): Promise<IORedis> {
  const port = Number(getConfig('REDIS_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('REDIS_PORT must be an integer between 1 and 65535.');
  }

  let password: string | undefined;
  try {
    password = await getSecret('env://REDIS_PASSWORD');
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
  }

  return factory({
    host: getConfig('REDIS_HOST'),
    port,
    password,
    maxRetriesPerRequest: null,
  });
}

/**
 * Singleton ioredis connection. MUST set `maxRetriesPerRequest: null` (BullMQ
 * requirement for blocking commands used by workers). Host/port/password from
 * the central config/secret loaders, defaulting to localhost:6379 / no password.
 */
export async function getRedisConnection(): Promise<IORedis> {
  if (closePending) await closePending;
  if (redisConnection) {
    return redisConnection;
  }
  if (redisConnectionPending) return redisConnectionPending;

  const generation = lifecycleGeneration;
  const pending = (async () => {
    const connection = await createRedisConnection();
    if (generation !== lifecycleGeneration) {
      await closeRedisConnection(connection);
      throw new QueueInitializationCancelledError();
    }
    redisConnection = connection;
    return connection;
  })();
  redisConnectionPending = pending;

  try {
    return await pending;
  } finally {
    if (redisConnectionPending === pending) redisConnectionPending = null;
  }
}

export async function getQueue<Q extends QueueName>(
  name: Q,
): Promise<Queue<MessageEnvelope<QueuePayloads[Q]>>> {
  if (closePending) await closePending;
  const existing = queues.get(name);
  if (existing) {
    return existing as Queue<MessageEnvelope<QueuePayloads[Q]>>;
  }
  const existingPending = queuePending.get(name);
  if (existingPending) {
    return existingPending as Promise<Queue<MessageEnvelope<QueuePayloads[Q]>>>;
  }

  const generation = lifecycleGeneration;
  const pending = (async () => {
    const connection = await getRedisConnection();
    if (generation !== lifecycleGeneration) {
      throw new QueueInitializationCancelledError();
    }

    const queue = new Queue<MessageEnvelope<QueuePayloads[Q]>>(name, { connection });
    if (generation !== lifecycleGeneration) {
      await queue.close();
      throw new QueueInitializationCancelledError();
    }
    queues.set(name, queue);
    return queue;
  })();
  queuePending.set(name, pending as Promise<Queue>);

  try {
    return await pending;
  } finally {
    if (queuePending.get(name) === pending) queuePending.delete(name);
  }
}

/**
 * Validates the envelope (`assertValidEnvelope`) then adds it. `jobName` = `envelope.type`.
 * Returns the BullMQ job id.
 */
export async function enqueue<Q extends QueueName>(
  name: Q,
  envelope: MessageEnvelope<QueuePayloads[Q]>,
  opts?: JobsOptions,
): Promise<string> {
  assertValidEnvelope(envelope);

  const queue = await getQueue(name);
  const job = await queue.add(envelope.type, envelope, {
    attempts: 1,
    removeOnComplete: true,
    ...opts,
  });

  return job.id ?? '';
}

/**
 * Worker factory. Wraps `handler` so `job.data` is validated (`assertValidEnvelope`)
 * BEFORE the handler runs — an envelope missing `org_id` fails the job instead of
 * reaching business code.
 */
export async function createWorker<Q extends QueueName>(
  name: Q,
  handler: (envelope: MessageEnvelope<QueuePayloads[Q]>, job: Job) => Promise<void>,
  opts?: Omit<WorkerOptions, 'connection'>,
): Promise<Worker> {
  const generation = lifecycleGeneration;
  const connection = await getRedisConnection();
  if (generation !== lifecycleGeneration) {
    throw new QueueInitializationCancelledError();
  }

  const worker = new Worker(
    name,
    async (job: Job) => {
      assertValidEnvelope(job.data);
      await handler(job.data as MessageEnvelope<QueuePayloads[Q]>, job);
    },
    {
      ...opts,
      connection,
    },
  );

  if (generation !== lifecycleGeneration) {
    await Promise.allSettled([worker.close()]);
    throw new QueueInitializationCancelledError();
  }

  return worker;
}

async function closeRedisConnection(connection: IORedis): Promise<void> {
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
}

/** Close cached and in-flight queues + connection (graceful shutdown / test teardown). */
export function closeQueues(): Promise<void> {
  if (closePending) return closePending;

  lifecycleGeneration += 1;
  const pending = (async () => {
    const initialization = [
      ...queuePending.values(),
      ...(redisConnectionPending ? [redisConnectionPending] : []),
    ];
    await Promise.allSettled(initialization);

    const queuesToClose = [...queues.values()];
    queues.clear();
    await Promise.allSettled(queuesToClose.map(async (queue) => queue.close()));

    const connection = redisConnection;
    redisConnection = null;
    if (connection) await closeRedisConnection(connection);
  })();
  closePending = pending;
  const clearCloseBarrier = () => {
    if (closePending === pending) closePending = null;
  };
  void pending.then(clearCloseBarrier, clearCloseBarrier);
  return pending;
}

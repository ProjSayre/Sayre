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
import IORedis from 'ioredis';
import { MessageEnvelope, assertValidEnvelope } from './envelope';

// One queue per integration (locked by ticket). This set is closed at the QUEUE level; a NEW
// git provider (e.g. Cursor Origin, PRD §6) is added as a new JOB TYPE / provider on the
// existing github-sync queue — NOT a new queue — per .claude/rules/async-messaging.md.
export const QUEUE_NAMES = ['github-sync', 'jira-sync', 'linear-sync'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// Typed job payloads (skeletons — integration tickets extend these).
export interface GithubSyncPayload {
  provider: 'github' | 'cursor-origin'; // provider-keyed; cursor-origin joins here later
  event: string; // e.g. 'push' | 'pull_request' | 'branch_created'
  installation_id: string;
  repo_full_name: string;
  delivery_id: string; // webhook delivery id (idempotency)
}
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
const queues = new Map<QueueName, Queue>();

/**
 * Singleton ioredis connection. MUST set `maxRetriesPerRequest: null` (BullMQ
 * requirement for blocking commands used by workers). Host/port/password from
 * `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` env, defaulting to localhost:6379 / no
 * password.
 */
export function getRedisConnection(): IORedis {
  if (redisConnection) {
    return redisConnection;
  }

  redisConnection = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });

  return redisConnection;
}

export function getQueue<Q extends QueueName>(name: Q): Queue<MessageEnvelope<QueuePayloads[Q]>> {
  const existing = queues.get(name);
  if (existing) {
    return existing as Queue<MessageEnvelope<QueuePayloads[Q]>>;
  }

  const queue = new Queue<MessageEnvelope<QueuePayloads[Q]>>(name, {
    connection: getRedisConnection(),
  });
  queues.set(name, queue);
  return queue;
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

  const queue = getQueue(name);
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
export function createWorker<Q extends QueueName>(
  name: Q,
  handler: (envelope: MessageEnvelope<QueuePayloads[Q]>, job: Job) => Promise<void>,
  opts?: WorkerOptions,
): Worker {
  return new Worker(
    name,
    async (job: Job) => {
      assertValidEnvelope(job.data);
      await handler(job.data as MessageEnvelope<QueuePayloads[Q]>, job);
    },
    {
      connection: getRedisConnection(),
      ...opts,
    },
  );
}

/** Close cached queues + connection (graceful shutdown / test teardown). */
export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) {
    await queue.close();
  }
  queues.clear();

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}

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
//
// Job LANES (W0-04, GAP-3a): `enqueue()` takes an optional `lane` ("priority" |
// "default", see JOB_LANES/LANE_PRIORITY below), mirroring the SQS side's separate
// physical `enrichment-onboarding-priority` / `enrichment-default` queues
// (docs/wave0-foundation-contracts.md) with one native BullMQ mechanism instead of a
// second physical queue per lane. BOTH lanes map to a NON-ZERO BullMQ `priority`
// value on purpose: BullMQ 5.28 keeps every unprioritized job (priority 0/undefined)
// in a separate `wait` list, and a worker's moveToActive drains `wait` COMPLETELY
// before it ever looks at the `prioritized` zset a nonzero priority routes into. If
// the default lane mapped to priority 0, a "default" job would sit in `wait` and
// would always win over a "priority" job sitting in `prioritized` — exactly backwards
// from the intent — so every job enqueue() adds lands in `prioritized`, and lane
// ordering is real ZPOPMIN ordering (lower priority number first, then FIFO).
// No job type is currently assigned the priority lane by policy — that is a
// separate, more opinionated decision left to a follow-up (see W0-04 spec.md's
// Open Questions); the three existing call sites are unchanged and stay on the
// default lane.
//
// Rollout caveat (EC-4): this guarantee only holds for jobs enqueued AFTER this
// change ships. Any job already sitting in `wait` from a pre-change deploy will
// still drain ahead of a newly enqueued prioritized job until `wait` empties out on
// its own — draining or migrating an in-flight queue on deploy is out of scope here.

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
export interface TicketUpdatePayload {
  title?: string;
  description?: string;
}

export interface TicketSyncPayload {
  provider: 'jira' | 'linear';
  direction: 'inbound' | 'outbound';
  external_ticket_id: string;
  repository_id: string;
  ref_name: string;
  patch?: TicketUpdatePayload;
}

export type JiraSyncPayload = TicketSyncPayload & { provider: 'jira' };
export type LinearSyncPayload = TicketSyncPayload & { provider: 'linear' };

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

  // Off by default (local dev's docker-compose redis:7.4-alpine has no TLS
  // listener). Managed Redis outside the VPC (e.g. Redis Cloud) sets
  // REDIS_TLS=true -- otherwise the AUTH password and all job payloads
  // cross whatever network sits between here and the Redis host in
  // plaintext.
  const tls = getConfig('REDIS_TLS') === 'true' ? {} : undefined;

  return factory({
    host: getConfig('REDIS_HOST'),
    port,
    password,
    tls,
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

/** Named lanes, mirroring the SQS split (`enrichment-onboarding-priority` / `enrichment-default`). */
export const JOB_LANES = ['priority', 'default'] as const;
export type JobLane = (typeof JOB_LANES)[number];

/**
 * BullMQ native `priority`: LOWER number = higher priority; the value 0 / undefined means
 * "unprioritized". Both lanes map to a NON-ZERO value on purpose — see the module header.
 */
export const LANE_PRIORITY: Readonly<Record<JobLane, number>> = { priority: 1, default: 2 };
export const DEFAULT_JOB_LANE: JobLane = 'default';

export type EnqueueOptions = Omit<JobsOptions, 'priority'> & { lane?: JobLane };

function isJobLane(value: unknown): value is JobLane {
  return typeof value === 'string' && (JOB_LANES as readonly string[]).includes(value);
}

/**
 * Validates the envelope (`assertValidEnvelope`) then adds it. `jobName` = `envelope.type`.
 * Returns the BullMQ job id.
 *
 * Lane resolution (W0-04, GAP-3a): `opts.lane` selects `JOB_LANES`, defaulting to
 * `DEFAULT_JOB_LANE` when omitted. Uses `=== undefined` rather than `??` deliberately —
 * an explicit `lane: null` (or any other non-`JobLane` value) must be REJECTED, not
 * silently coerced to the default lane. A raw `priority` key on `opts` is rejected too:
 * `EnqueueOptions`'s `Omit<JobsOptions, 'priority'>` is a compile-time guard only (erased
 * at runtime), and a bare `priority: 0`/`undefined` from an unsafe caller would silently
 * defeat the "every job lands in `prioritized`" guarantee this module's header describes.
 */
export async function enqueue<Q extends QueueName>(
  name: Q,
  envelope: MessageEnvelope<QueuePayloads[Q]>,
  opts?: EnqueueOptions,
): Promise<string> {
  assertValidEnvelope(envelope);

  const rawOpts = (opts ?? {}) as Record<string, unknown>;
  if ('priority' in rawOpts) {
    throw new Error(
      'enqueue() does not accept a raw `priority` option — pass `lane` ("priority" | "default") ' +
        'instead; a bare priority can silently defeat the lane guarantee (see the module header).',
    );
  }

  const rawLane = rawOpts.lane;
  const lane = rawLane === undefined ? DEFAULT_JOB_LANE : rawLane;
  if (!isJobLane(lane)) {
    throw new Error(
      `enqueue() received an unknown lane ${JSON.stringify(rawLane)}; supported lanes are ${JOB_LANES.join(', ')}.`,
    );
  }

  const rest: Record<string, unknown> = { ...rawOpts };
  delete rest.lane;

  const queue = await getQueue(name);
  const job = await queue.add(envelope.type, envelope, {
    attempts: 1,
    removeOnComplete: true,
    ...(rest as JobsOptions),
    priority: LANE_PRIORITY[lane],
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

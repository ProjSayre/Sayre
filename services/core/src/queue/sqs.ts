// Node SQS producer targeting the Python worker fleet's ingestion queue.
//
// Permanent fleet split (`.claude/rules/async-messaging.md`): SQS backs the Python
// worker fleet; BullMQ backs Node integration workers (`services/core/src/queue/bullmq.ts`).
// This module is the anticipated exception to that split's CONSUME direction, not a
// violation of it: `services/core` (Node) PRODUCES onto the Python fleet's
// `ingestion.fifo` queue from the GitHub webhook receiver (W1-02) — Python remains
// the exclusive CONSUMER (`services/workers/messaging/sqs_client.py`, `INGESTION_QUEUE`).
// Do not add a consumer/worker loop here.
//
// Webhook-trust invariant (`.claude/rules/security-multitenancy.md`): callers MUST
// resolve `org_id` server-side and HMAC-validate the webhook body BEFORE calling
// `publish`/`publishIngestionEvent` — this module enforces FIFO shape only, it does
// not implement that check itself.

import { createHash } from 'node:crypto';
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import { ConfigError, getConfig, getSecret, SecretNotFoundError, type SecretRef } from '@sayre/config';
import type { NormalizedRepoEvent, RepoInitialParseEvent } from '@sayre/shared-types';
import type { MessageEnvelope } from './envelope';

// Matches `INGESTION_QUEUE` in services/workers/messaging/sqs_client.py — one
// physical, per-work-type FIFO queue (NOT per-tenant); tenant context lives in the
// envelope's org_id, never in the queue name.
export const INGESTION_QUEUE = 'ingestion.fifo';

let client: SQSClient | null = null;
let clientPending: Promise<SQSClient> | null = null;
const queueUrlCache = new Map<string, string>();

async function optionalSecret(ref: SecretRef): Promise<string | undefined> {
  try {
    return await getSecret(ref);
  } catch (error) {
    if (error instanceof SecretNotFoundError) return undefined;
    throw error;
  }
}

/** Unset SQS_ENDPOINT_URL (a ConfigError, no default) means "use real AWS". */
function resolveEndpointUrl(): string | undefined {
  try {
    return getConfig('SQS_ENDPOINT_URL');
  } catch (error) {
    if (error instanceof ConfigError) return undefined;
    throw error;
  }
}

/**
 * Singleton SQSClient built from AWS_REGION + optional SQS_ENDPOINT_URL (LocalStack) and optional
 * AWS credentials resolved via getSecret (env://AWS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _SESSION_TOKEN).
 * Factory param exists only for tests (guard with NODE_ENV==='test').
 */
export async function getSqsClient(
  factory?: (cfg: SQSClientConfig) => SQSClient,
): Promise<SQSClient> {
  if (factory && getConfig('NODE_ENV') !== 'test') {
    throw new Error('SQS client factory injection is unavailable outside tests.');
  }
  if (client) return client;
  if (clientPending) return clientPending;

  const pending = (async () => {
    const region = getConfig('AWS_REGION');
    const endpoint = resolveEndpointUrl();
    const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
      optionalSecret('env://AWS_ACCESS_KEY_ID'),
      optionalSecret('env://AWS_SECRET_ACCESS_KEY'),
      optionalSecret('env://AWS_SESSION_TOKEN'),
    ]);
    if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
      throw new Error('AWS access-key credentials must be provisioned as a complete pair.');
    }

    const config: SQSClientConfig = {
      region,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(accessKeyId !== undefined && secretAccessKey !== undefined
        ? { credentials: { accessKeyId, secretAccessKey, sessionToken } }
        : {}),
    };

    const instance = (factory ?? ((cfg) => new SQSClient(cfg)))(config);
    client = instance;
    return instance;
  })();
  clientPending = pending;

  try {
    return await pending;
  } finally {
    if (clientPending === pending) clientPending = null;
  }
}

async function resolveQueueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  const cached = queueUrlCache.get(queueName);
  if (cached) return cached;

  const response = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!response.QueueUrl) {
    throw new Error(`SQS did not return a QueueUrl for queue "${queueName}".`);
  }
  queueUrlCache.set(queueName, response.QueueUrl);
  return response.QueueUrl;
}

/**
 * Length-prefixed SHA-256 over (org_id, provider_repo_id, ref_name) — mirrors the Python
 * `ingestion_group_id` (services/workers/messaging/sqs_client.py) byte-for-byte so FIFO
 * grouping is stable per org/repo/ref regardless of which fleet produced the message.
 * Rejects blank components.
 */
export function ingestionGroupId(orgId: string, providerRepoId: string, refName: string): string {
  const components: Array<[string, string]> = [
    ['org_id', orgId],
    ['provider_repo_id', providerRepoId],
    ['ref_name', refName],
  ];
  const chunks: Buffer[] = [];
  for (const [name, value] of components) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${name} must not be blank`);
    }
    const encoded = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(encoded.length));
    chunks.push(length, encoded);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

/**
 * Publish a MessageEnvelope to a queue. For a *.fifo queue, messageGroupId is required and
 * messageDeduplicationId defaults to envelope.idempotency_key. Serializes the envelope with
 * JSON.stringify (snake_case keys → byte-compatible with the Python MessageEnvelope.from_body).
 */
export async function publish(
  queueName: string,
  envelope: MessageEnvelope<unknown>,
  opts?: { messageGroupId?: string; messageDeduplicationId?: string },
): Promise<string> {
  const isFifo = queueName.endsWith('.fifo');
  if (isFifo && (!opts?.messageGroupId || opts.messageGroupId.trim().length === 0)) {
    throw new Error('messageGroupId is required for FIFO queues.');
  }
  if (!isFifo && (opts?.messageGroupId !== undefined || opts?.messageDeduplicationId !== undefined)) {
    throw new Error('FIFO publishing arguments are invalid for a standard queue.');
  }

  const sqs = await getSqsClient();
  const queueUrl = await resolveQueueUrl(sqs, queueName);

  const response = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      ...(isFifo
        ? {
            MessageGroupId: opts?.messageGroupId,
            MessageDeduplicationId: opts?.messageDeduplicationId ?? envelope.idempotency_key,
          }
        : {}),
    }),
  );

  if (!response.MessageId) {
    throw new Error(`SQS publish to "${queueName}" did not return a MessageId.`);
  }
  return response.MessageId;
}

/** Convenience wrapper: sets MessageGroupId = ingestionGroupId(...) and dedup = envelope.idempotency_key. */
export async function publishIngestionEvent(
  envelope: MessageEnvelope<NormalizedRepoEvent>,
): Promise<string> {
  const { repo, ref } = envelope.payload;
  if (!ref) {
    throw new Error('publishIngestionEvent requires a non-null ref for FIFO grouping.');
  }
  return publish(INGESTION_QUEUE, envelope, {
    messageGroupId: ingestionGroupId(envelope.org_id, repo.provider_repo_id, ref),
    messageDeduplicationId: envelope.idempotency_key,
  });
}

/**
 * Sibling of `publishIngestionEvent` for the `repo.initial_parse` message type
 * (W1-06 GitHub App install callback -> W1-05 ingestion worker). Requires a
 * non-null `ref` (a full parse always targets a concrete revision) and
 * FIFO-groups by `ingestionGroupId(org_id, provider_repo_id, ref)` — the SAME
 * grouping scheme as `publishIngestionEvent`, so an initial parse and any
 * subsequent delta for the same (org, repo, ref) serialize on one FIFO
 * message group regardless of which flow produced them.
 */
export async function publishInitialParseEvent(
  envelope: MessageEnvelope<RepoInitialParseEvent>,
): Promise<string> {
  const { repo, ref } = envelope.payload;
  if (!ref) {
    throw new Error('publishInitialParseEvent requires a non-null ref for FIFO grouping.');
  }
  return publish(INGESTION_QUEUE, envelope, {
    messageGroupId: ingestionGroupId(envelope.org_id, repo.provider_repo_id, ref),
    messageDeduplicationId: envelope.idempotency_key,
  });
}

/** Graceful shutdown / test teardown. */
export async function closeSqsClient(): Promise<void> {
  const current = client;
  client = null;
  clientPending = null;
  queueUrlCache.clear();
  if (current && typeof current.destroy === 'function') {
    current.destroy();
  }
}

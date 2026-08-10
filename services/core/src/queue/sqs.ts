// Node SQS producer targeting the Python worker fleet's ingestion queue.
//
// Permanent fleet split (`.claude/rules/async-messaging.md`): SQS backs the Python
// worker fleet; BullMQ backs Node integration workers (`services/core/src/queue/bullmq.ts`).
// This module is the anticipated exception to that split's CONSUME direction, not a
// violation of it: `services/core` (Node) PRODUCES onto the Python fleet's
// `ingestion.fifo` queue from the GitHub webhook receiver (W1-02) — Python remains
// the exclusive CONSUMER (`services/workers/messaging/sqs_client.py`, `INGESTION_QUEUE`).
// Do not add a consumer/worker loop here. CH-03's `chat-turns.fifo` (below) is a
// THIRD produce-only exception to the same fleet-split consume direction:
// `services/core`'s chatService produces a `chat.turn.request` work order after
// committing a user turn + its pending assistant turn; CH-04's Python consumer is
// the exclusive CONSUMER, exactly like INGESTION_QUEUE and ENRICHMENT_DEFAULT_QUEUE.
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

// Matches `ENRICHMENT_DEFAULT_QUEUE` in services/workers/messaging/sqs_client.py.
// A second, narrower exception to the fleet-split CONSUME direction (see this
// module's header): `services/core` PRODUCES a `ticket.reference_match` request
// here when a synced ticket has no explicit `[sayre:file:...]` tag, and the
// Python enrichment worker's `TicketReferenceMatcher` is the exclusive consumer
// (hands-on gap-fix build, see docs/post-mvp-backlog.md). Standard (non-FIFO)
// queue — no messageGroupId/messageDeduplicationId.
export const ENRICHMENT_DEFAULT_QUEUE = 'enrichment-default';

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
 * SQS FIFO limits MessageDeduplicationId to 128 characters. Envelope
 * idempotency keys intentionally retain their human-readable semantic tuple,
 * which may contain a valid Git ref long enough to exceed that boundary.
 * Hash the UTF-8 bytes for a stable, fixed-width, SQS-safe transport ID while
 * keeping the original key inside the message envelope.
 */
export function messageDeduplicationId(idempotencyKey: string): string {
  if (idempotencyKey.trim().length === 0) {
    throw new Error('idempotency key must not be blank');
  }
  return createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
}

/**
 * Publish a MessageEnvelope to a queue. For a *.fifo queue, messageGroupId is required and
 * the semantic messageDeduplicationId defaults to envelope.idempotency_key. The
 * semantic value is SHA-256 hashed before it enters SQS so every transport ID
 * stays inside the 128-character limit. Serializes the envelope with
 * JSON.stringify (snake_case keys → byte-compatible with the Python
 * MessageEnvelope.from_body).
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
            MessageDeduplicationId: messageDeduplicationId(
              opts?.messageDeduplicationId ?? envelope.idempotency_key,
            ),
          }
        : {}),
    }),
  );

  if (!response.MessageId) {
    throw new Error(`SQS publish to "${queueName}" did not return a MessageId.`);
  }
  return response.MessageId;
}

/** Convenience wrapper: sets the stable group and semantic deduplication key. */
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

export interface TicketReferenceMatchRequest {
  repository_id: string;
  ref_name: string;
  provider: 'jira' | 'linear';
  external_ticket_id: string;
  title: string;
  description: string | null;
}

/**
 * Publishes a request for the Python `TicketReferenceMatcher` to embed a
 * ticket's title+description and find its most similar file via
 * `code_embeddings` cosine search, only when the ticket has no explicit
 * reference tag. Standard queue — no FIFO grouping.
 */
export async function publishTicketReferenceMatchEvent(
  envelope: MessageEnvelope<TicketReferenceMatchRequest>,
): Promise<string> {
  return publish(ENRICHMENT_DEFAULT_QUEUE, envelope);
}

// ---------------------------------------------------------------------------
// CH-03 — "Ask Sayre" chat-turns.fifo lane. Matches `CHAT_TURNS_QUEUE` in
// services/workers/messaging/sqs_client.py, which CH-04 exclusively consumes.
// Deliberately NOT subscribed to the `graph-updated` SNS topic (spec.md
// "Out") — see infra/localstack/init/ready.d/01-create-sqs-queues.sh.
// ---------------------------------------------------------------------------
export const CHAT_TURNS_QUEUE = 'chat-turns.fifo';

/**
 * PINNED WIRE CONTRACT — CH-04 consumes this verbatim. Key order is part of
 * the contract (spec.md AC-6): callers must construct object literals with
 * these keys in this exact order.
 */
export interface ChatTurnRequestPayload {
  schema: 'chat.turn.request.v1';
  turnId: string; // the ASSISTANT turn id — the row CH-04 writes into
  conversationId: string;
  orgId: string;
  userId: string;
  question: string;
  scope: { view: 'technical' | 'product' | 'onboarding' | null; anchorNodeId: string | null };
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  mcpCredential: string | null; // always null until CH-04 wires minting
}

/**
 * Publishes a `chat.turn.request.v1` envelope to `chat-turns.fifo`, grouped
 * by conversation id (per-conversation ordering) and deduplicated by the
 * envelope's semantic `idempotency_key` (SHA-256 hashed by `publish()` into
 * the 128-char transport id).
 */
export async function publishChatTurnRequest(
  envelope: MessageEnvelope<ChatTurnRequestPayload>,
): Promise<string> {
  const conversationId = envelope.payload.conversationId;
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    throw new Error('publishChatTurnRequest requires a non-blank payload.conversationId to group by.');
  }
  return publish(CHAT_TURNS_QUEUE, envelope, {
    messageGroupId: conversationId,
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

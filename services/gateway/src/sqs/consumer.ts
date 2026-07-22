// Long-polling consumer of the already-provisioned `graph-updated-realtime` SQS
// queue (SNS `graph-updated` topic -> `graph-updated-realtime`,
// RawMessageDelivery=true, DLQ configured after 5 receives — see
// infra/localstack/init/ready.d/01-create-sqs-queues.sh). This is the first
// Node consumer of a Python-fleet SQS queue (W2-03 O-1): the gateway is the
// Realtime Service box in docs/architecture.md, and .claude/rules/async-
// messaging.md says the Realtime Service fans out graph.updated. It is an
// inbound counterpart to the outbound exception already documented in
// services/core/src/queue/sqs.ts (a pure producer, which deliberately has no
// consumer loop) — do not add a second consumer loop there.
//
// Client construction REUSES services/core/src/queue/sqs.ts's PATTERN (region +
// optional SQS_ENDPOINT_URL + optional AWS creds via getSecret), reimplemented
// locally rather than imported: that module is producer-only by design and is
// not part of @sayre/core's library export surface (see ../coreClient.ts /
// services/core/src/lib.ts, which exists specifically to avoid this kind of
// duplication for auth/envelope validation — SQS client construction is a much
// smaller, self-contained piece of config plumbing, not a second
// implementation of business logic).
//
// Queue semantics (AC7): a malformed/unprocessable message or a failed
// onEnvelope is NEVER deleted — it is left for SQS redrive (-> DLQ after 5
// receives). A successfully fanned-out message is deleted exactly once.

import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import { ConfigError, getConfig, getSecret, SecretNotFoundError, type SecretRef } from '@sayre/config';
import { assertValidEnvelope, type MessageEnvelope } from '@sayre/core';
import type { GraphUpdatedPayload } from '@sayre/shared-types';

export interface RealtimeSqsConsumer {
  start(): void;
  stop(): Promise<void>;
}

export interface RealtimeSqsConsumerOpts {
  queueName: string;
  onEnvelope: (env: MessageEnvelope<GraphUpdatedPayload>) => Promise<void>;
  visibilityTimeoutSeconds?: number; // default 30
  waitTimeSeconds?: number; // default 20 (long-poll)
  /** Test-only injection point — bypasses real AWS credential/endpoint resolution. */
  clientFactory?: () => SQSClient;
}

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

async function buildSqsClient(): Promise<SQSClient> {
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
  return new SQSClient(config);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRealtimeSqsConsumer(opts: RealtimeSqsConsumerOpts): RealtimeSqsConsumer {
  const visibilityTimeoutSeconds = opts.visibilityTimeoutSeconds ?? 30;
  const waitTimeSeconds = opts.waitTimeSeconds ?? 20;

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let clientPromise: Promise<SQSClient> | null = null;
  let queueUrl: string | null = null;

  function getClient(): Promise<SQSClient> {
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() => (opts.clientFactory ? opts.clientFactory() : buildSqsClient()));
    }
    return clientPromise;
  }

  async function getQueueUrl(client: SQSClient): Promise<string> {
    if (queueUrl) return queueUrl;
    const response = await client.send(new GetQueueUrlCommand({ QueueName: opts.queueName }));
    if (!response.QueueUrl) {
      throw new Error(`SQS did not return a QueueUrl for queue "${opts.queueName}".`);
    }
    queueUrl = response.QueueUrl;
    return queueUrl;
  }

  function parseEnvelope(body: string): MessageEnvelope<GraphUpdatedPayload> {
    const parsed: unknown = JSON.parse(body);
    assertValidEnvelope(parsed);
    if (parsed.type !== 'graph.updated') {
      throw new Error(`Unexpected envelope type "${parsed.type}" on "${opts.queueName}".`);
    }
    return parsed as MessageEnvelope<GraphUpdatedPayload>;
  }

  async function processMessage(client: SQSClient, url: string, message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) return;

    let envelope: MessageEnvelope<GraphUpdatedPayload>;
    try {
      envelope = parseEnvelope(message.Body);
    } catch (err) {
      // Malformed/unprocessable -> leave for redrive -> DLQ after 5 receives (AC7).
      console.error('[gateway] discarding unprocessable SQS message (left for redrive)', err);
      return;
    }

    try {
      await opts.onEnvelope(envelope);
    } catch (err) {
      // Redis publish (or any onEnvelope step) failed -> leave for redelivery,
      // never delete on failure (AC7 / edge case: "Redis publish fails").
      console.error('[gateway] onEnvelope failed; leaving message for redelivery', err);
      return;
    }

    try {
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    } catch (err) {
      // Successfully fanned out but delete failed -> at-least-once redelivery is
      // expected and must be handled idempotently downstream; never crash here.
      console.error('[gateway] failed to delete SQS message after successful fan-out', err);
    }
  }

  async function pollOnce(client: SQSClient, url: string): Promise<void> {
    let response;
    try {
      response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          VisibilityTimeout: visibilityTimeoutSeconds,
          WaitTimeSeconds: waitTimeSeconds,
        }),
      );
    } catch (err) {
      console.error('[gateway] SQS receive failed; retrying after a short backoff', err);
      await sleep(1_000);
      return;
    }
    const messages = response.Messages ?? [];
    await Promise.all(messages.map((message) => processMessage(client, url, message)));
  }

  async function pollLoop(): Promise<void> {
    const client = await getClient();
    const url = await getQueueUrl(client);
    while (!stopped) {
      await pollOnce(client, url);
    }
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      loopPromise = pollLoop().catch((err) => {
        console.error('[gateway] realtime SQS consumer loop crashed', err);
      });
    },
    async stop(): Promise<void> {
      // Graceful shutdown: stop accepting new receives. Any message already
      // in-flight inside processMessage() is allowed to finish (its delete only
      // happens after a successful onEnvelope) — an abrupt stop mid-receive
      // leaves that batch's messages undeleted for natural redelivery, never
      // deleted without being fanned out.
      stopped = true;
      if (loopPromise) await loopPromise;
      loopPromise = null;
    },
  };
}

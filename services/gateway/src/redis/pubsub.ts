// Redis pub/sub fan-out ACROSS gateway instances: one dedicated ioredis
// *subscriber* connection + one *publisher* connection (ioredis requires a
// separate connection while SUBSCRIBEd). Connection config mirrors
// services/core/src/queue/bullmq.ts's createRedisConnection EXACTLY (same
// REDIS_HOST/REDIS_PORT/REDIS_PASSWORD resolution via @sayre/config, same
// maxRetriesPerRequest: null) — no new/unrelated Redis client setup style.
//
// Reconnect behavior: ioredis tracks subscribed channels internally and
// automatically re-issues SUBSCRIBE after a reconnect, so a dropped
// subscriber connection resubscribes on its own; any `graph.updated` events
// published during the gap are not lost because SQS delivery is
// at-least-once and the message is only deleted after a successful publish
// (see ../sqs/consumer.ts) — redelivery covers the gap, not this module.

import IORedis, { type RedisOptions } from 'ioredis';
import { getConfig, getSecret, SecretNotFoundError } from '@sayre/config';
import { assertValidEnvelope, type MessageEnvelope } from '@sayre/core';
import type { GraphUpdatedPayload } from '@sayre/shared-types';

export interface GraphUpdatedBus {
  publish(envelope: MessageEnvelope<GraphUpdatedPayload>): Promise<void>;
  subscribe(handler: (envelope: MessageEnvelope<GraphUpdatedPayload>) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export type RedisConnectionFactory = (options: RedisOptions) => IORedis;

const defaultFactory: RedisConnectionFactory = (options) => new IORedis(options);

/** Mirrors services/core/src/queue/bullmq.ts#createRedisConnection byte-for-byte. */
async function createRedisConnection(factory: RedisConnectionFactory): Promise<IORedis> {
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

function parseEnvelope(raw: string): MessageEnvelope<GraphUpdatedPayload> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    assertValidEnvelope(parsed);
    return parsed as MessageEnvelope<GraphUpdatedPayload>;
  } catch (err) {
    console.error('[gateway] discarding malformed Redis pub/sub message', err);
    return null;
  }
}

export async function createGraphUpdatedBus(
  channel: string,
  factory: RedisConnectionFactory = defaultFactory,
): Promise<GraphUpdatedBus> {
  const subscriber = await createRedisConnection(factory);
  const publisher = await createRedisConnection(factory);

  let handler: ((envelope: MessageEnvelope<GraphUpdatedPayload>) => Promise<void>) | null = null;

  subscriber.on('message', (receivedChannel, message) => {
    if (receivedChannel !== channel || !handler) return;
    const envelope = parseEnvelope(message);
    if (!envelope) return;
    void handler(envelope).catch((err) => {
      console.error('[gateway] error handling fanned-out graph.updated event', err);
    });
  });

  return {
    async publish(envelope: MessageEnvelope<GraphUpdatedPayload>): Promise<void> {
      await publisher.publish(channel, JSON.stringify(envelope));
    },
    async subscribe(
      next: (envelope: MessageEnvelope<GraphUpdatedPayload>) => Promise<void>,
    ): Promise<void> {
      handler = next;
      await subscriber.subscribe(channel);
    },
    async close(): Promise<void> {
      await Promise.allSettled([subscriber.quit(), publisher.quit()]);
    },
  };
}

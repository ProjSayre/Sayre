// CH-05 — ChatEventBus: one dedicated ioredis *subscriber* connection (the
// gateway never publishes a chat event, so no publisher connection is
// created), with refcounted per-conversation SUBSCRIBE/UNSUBSCRIBE and
// strictly per-channel-ordered handler dispatch.
//
// Ordering rationale: redis/pubsub.ts's graph bus dispatches handlers
// fire-and-forget (`void handler(envelope).catch(...)`) because graph.updated
// events are not order-significant. Chat events ARE order-significant (AC-1's
// monotonic `seq`), and each handler invocation awaits a Core round-trip via
// fanout/chatFanout.ts's relayChatEvent, so a naive fire-and-forget dispatch
// would let a slow first authorization call be overtaken by a faster later
// one. This module therefore serializes handler invocations per channel with
// a promise chain.

import IORedis from 'ioredis';
import { createRedisConnection, type RedisConnectionFactory } from './pubsub';
import { decodeChatEvent, type DecodedChatEvent } from '../ws/chatEvents';

export interface ChatEventBus {
  /** Refcounted. Issues a real Redis SUBSCRIBE only on the 0 -> 1 transition. */
  subscribe(channel: string): Promise<void>;
  /** Refcounted. Issues a real Redis UNSUBSCRIBE only on the 1 -> 0 transition. No-op at 0. */
  unsubscribe(channel: string): Promise<void>;
  onEvent(handler: (event: DecodedChatEvent) => Promise<void>): void;
  /** Channels with a live refcount > 0. Exists so AC-5's no-leak assertion is real. */
  subscribedChannels(): string[];
  close(): Promise<void>;
}

const defaultFactory: RedisConnectionFactory = (options) => new IORedis(options);

/** Reuses redis/pubsub.ts's createRedisConnection (same REDIS_HOST/PORT/PASSWORD
 *  resolution, same maxRetriesPerRequest: null). Subscriber-only — the gateway never
 *  publishes a chat event, so no publisher connection is created. */
export async function createChatEventBus(
  factory: RedisConnectionFactory = defaultFactory,
): Promise<ChatEventBus> {
  const subscriber = await createRedisConnection(factory);

  const refcounts = new Map<string, number>();
  // Per-channel promise chain: each incoming message's handler invocation is
  // appended onto the tail so invocations for one conversation run strictly
  // in arrival order, even though each awaits a slow Core round-trip.
  const chains = new Map<string, Promise<void>>();
  let handler: ((event: DecodedChatEvent) => Promise<void>) | null = null;

  subscriber.on('message', (receivedChannel: string, message: string) => {
    if ((refcounts.get(receivedChannel) ?? 0) <= 0) return; // EC-24/EC-25: no live subscriber
    const event = decodeChatEvent(receivedChannel, message);
    if (!event) return; // decodeChatEvent already logs the drop reason

    const previous = chains.get(receivedChannel) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (!handler) return;
      try {
        await handler(event);
      } catch (err) {
        console.error('[gateway] error handling chat event', err);
      }
    });
    chains.set(receivedChannel, next);
  });

  return {
    async subscribe(channel: string): Promise<void> {
      const current = refcounts.get(channel) ?? 0;
      refcounts.set(channel, current + 1);
      if (current === 0) {
        await subscriber.subscribe(channel);
      }
    },
    async unsubscribe(channel: string): Promise<void> {
      const current = refcounts.get(channel) ?? 0;
      if (current <= 0) return; // never subscribed -- silent no-op
      const next = current - 1;
      if (next === 0) {
        refcounts.delete(channel);
        chains.delete(channel);
        await subscriber.unsubscribe(channel);
      } else {
        refcounts.set(channel, next);
      }
    },
    onEvent(next: (event: DecodedChatEvent) => Promise<void>): void {
      handler = next;
    },
    subscribedChannels(): string[] {
      return [...refcounts.keys()];
    },
    async close(): Promise<void> {
      await subscriber.quit();
    },
  };
}

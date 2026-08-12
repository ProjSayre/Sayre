// CH-05 — ChatEventBus: one dedicated ioredis subscriber connection, refcounted
// per-conversation SUBSCRIBE/UNSUBSCRIBE, and strictly ordered per-channel
// handler dispatch. Authored by `red` from .pipeline/spec.md before any
// implementation exists.
//
// Uses the FakeRedis convention already established in ./pubsub.test.ts
// (EventEmitter + injected RedisConnectionFactory + setConfigOverrideForTests)
// — no live Redis anywhere.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import type { RedisConnectionFactory } from './pubsub';
import { createChatEventBus } from './chatPubsub';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const TURN_ID = '66666666-6666-4666-8666-666666666666';
const TS = '2026-08-11T00:00:00.000000Z';

const CHANNEL = `sayre:chat.events:${ORG_ID}:${CONVERSATION_ID}`;
const OTHER_CHANNEL = `sayre:chat.events:${ORG_ID}:${OTHER_CONVERSATION_ID}`;

function progressJson(seq: number): string {
  return JSON.stringify({
    message_id: `m-${seq}`,
    idempotency_key: `chat.turn.progress:${TURN_ID}:${seq}`,
    org_id: ORG_ID,
    type: 'chat.turn.progress',
    schema_version: 1,
    occurred_at: TS,
    source: 'sayre-chat-worker',
    payload: {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      seq,
      kind: 'status',
      tool: null,
      detail: null,
      ts: TS,
    },
  });
}

class FakeRedis extends EventEmitter {
  subscribeCalls: string[] = [];
  unsubscribeCalls: string[] = [];
  quit = vi.fn(async () => 'OK');

  async subscribe(channel: string): Promise<number> {
    this.subscribeCalls.push(channel);
    return this.subscribeCalls.length;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.unsubscribeCalls.push(channel);
    return 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    void channel;
    void message;
    return 1;
  }
}

let instances: FakeRedis[] = [];

function trackingFactory(): RedisConnectionFactory {
  return () => {
    const instance = new FakeRedis();
    instances.push(instance);
    return instance as unknown as ReturnType<RedisConnectionFactory>;
  };
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  instances = [];
  setConfigOverrideForTests('REDIS_HOST', 'localhost');
  setConfigOverrideForTests('REDIS_PORT', '6379');
});

afterEach(() => {
  resetConfigForTests();
  vi.restoreAllMocks();
});

describe('createChatEventBus — connection shape', () => {
  // @spec AC-5
  it('AC-5: creates exactly ONE (subscriber-only) connection — the gateway never publishes chat events', async () => {
    const bus = await createChatEventBus(trackingFactory());

    expect(instances).toHaveLength(1);
    await bus.close();
  });

  // @spec AC-5
  it('AC-5: close() quits the subscriber connection', async () => {
    const bus = await createChatEventBus(trackingFactory());
    await bus.close();

    expect(instances[0].quit).toHaveBeenCalledTimes(1);
  });

  // @spec AC-10
  it('AC-10: reuses redis/pubsub.ts createRedisConnection — same REDIS_PORT validation, unchanged', async () => {
    setConfigOverrideForTests('REDIS_PORT', '99999');

    await expect(createChatEventBus(trackingFactory())).rejects.toThrow(/REDIS_PORT/);
  });
});

describe('createChatEventBus — refcounted subscribe/unsubscribe', () => {
  // @spec AC-5 EC-9
  it('AC-5/EC-9: a real SUBSCRIBE is issued only on the 0 -> 1 transition', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;

    await bus.subscribe(CHANNEL);
    await bus.subscribe(CHANNEL);
    await bus.subscribe(CHANNEL);

    expect(redis.subscribeCalls).toEqual([CHANNEL]);
    expect(bus.subscribedChannels()).toEqual([CHANNEL]);
    await bus.close();
  });

  // @spec AC-5 EC-21
  it('AC-5/EC-21: a real UNSUBSCRIBE is issued only on the 1 -> 0 transition, exactly once', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;

    await bus.subscribe(CHANNEL); // tab 1
    await bus.subscribe(CHANNEL); // tab 2

    await bus.unsubscribe(CHANNEL); // tab 1 disconnects
    expect(redis.unsubscribeCalls).toEqual([]);
    expect(bus.subscribedChannels()).toEqual([CHANNEL]);

    await bus.unsubscribe(CHANNEL); // tab 2 disconnects
    expect(redis.unsubscribeCalls).toEqual([CHANNEL]);
    expect(bus.subscribedChannels()).toEqual([]);

    await bus.close();
  });

  // @spec EC-10
  it('EC-10: unsubscribe at refcount 0 (never subscribed) is a silent no-op — no Redis call, no throw', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;

    await expect(bus.unsubscribe(CHANNEL)).resolves.toBeUndefined();
    await expect(bus.unsubscribe(CHANNEL)).resolves.toBeUndefined();

    expect(redis.unsubscribeCalls).toEqual([]);
    expect(bus.subscribedChannels()).toEqual([]);
    await bus.close();
  });

  // @spec AC-5
  it('AC-5: subscribing again after a full release issues a second real SUBSCRIBE', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;

    await bus.subscribe(CHANNEL);
    await bus.unsubscribe(CHANNEL);
    await bus.subscribe(CHANNEL);

    expect(redis.subscribeCalls).toEqual([CHANNEL, CHANNEL]);
    expect(bus.subscribedChannels()).toEqual([CHANNEL]);
    await bus.close();
  });

  // @spec AC-5
  it('AC-5: subscribedChannels() tracks each channel independently', async () => {
    const bus = await createChatEventBus(trackingFactory());

    await bus.subscribe(CHANNEL);
    await bus.subscribe(OTHER_CHANNEL);
    await bus.unsubscribe(CHANNEL);

    expect(bus.subscribedChannels()).toEqual([OTHER_CHANNEL]);
    await bus.close();
  });
});

describe('createChatEventBus — dispatch', () => {
  // @spec AC-1
  it('AC-1: handler invocations for one conversation run strictly in arrival order, even when each awaits a slow Core round-trip', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    await bus.subscribe(CHANNEL);

    const timeline: string[] = [];
    // Deliberately INVERTED delays: if the reader dispatched concurrently
    // (the graph bus's `void handler(...)` idiom), seq 3 would finish first and
    // the timeline would read 3,2,1. Only a per-channel serialization can make
    // the completion order 1,2,3.
    const delayForSeq: Record<number, number> = { 1: 40, 2: 20, 3: 5 };
    let finished: () => void = () => undefined;
    const allDone = new Promise<void>((resolve) => {
      finished = resolve;
    });

    bus.onEvent(async (event) => {
      const { seq } = event.push as { seq: number };
      timeline.push(`start:${seq}`);
      await tick(delayForSeq[seq]);
      timeline.push(`end:${seq}`);
      if (seq === 3) finished();
    });

    redis.emit('message', CHANNEL, progressJson(1));
    redis.emit('message', CHANNEL, progressJson(2));
    redis.emit('message', CHANNEL, progressJson(3));

    await allDone;

    expect(timeline).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
    await bus.close();
  });

  // @spec AC-1
  it('AC-1: a rejected handler is logged and never breaks the chain for subsequent events', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    await bus.subscribe(CHANNEL);

    const seen: number[] = [];
    bus.onEvent(async (event) => {
      const { seq } = event.push as { seq: number };
      if (seq === 1) throw new Error('core exploded');
      seen.push(seq);
    });

    redis.emit('message', CHANNEL, progressJson(1));
    redis.emit('message', CHANNEL, progressJson(2));
    redis.emit('message', CHANNEL, progressJson(3));
    await tick(20);

    expect(seen).toEqual([2, 3]);
    await bus.close();
  });

  // @spec AC-7 EC-1
  it('AC-7/EC-1: an undecodable message is dropped — the handler is never invoked and the bus does not crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    await bus.subscribe(CHANNEL);

    const handler = vi.fn(async () => undefined);
    bus.onEvent(handler);

    redis.emit('message', CHANNEL, 'not json');
    redis.emit('message', CHANNEL, JSON.stringify({ nope: true }));
    await tick(10);

    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });

  // @spec EC-24 EC-25
  it('EC-24/EC-25: a message on a channel with no live refcount is ignored', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    const handler = vi.fn(async () => undefined);
    bus.onEvent(handler);

    redis.emit('message', CHANNEL, progressJson(1));
    await tick(10);

    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });

  // @spec EC-24
  it('EC-24: nothing is buffered or replayed — a later subscribe never redelivers an earlier message', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    const handler = vi.fn(async () => undefined);
    bus.onEvent(handler);

    redis.emit('message', CHANNEL, progressJson(1)); // arrives before anyone subscribes
    await tick(5);

    await bus.subscribe(CHANNEL);
    await tick(10);

    expect(handler).not.toHaveBeenCalled(); // at-most-once; CH-03's REST read is the catch-up path
    await bus.close();
  });

  // @spec EC-24
  it('EC-24: the bus adds no reconnect logic of its own — a subscriber reconnect re-issues no SUBSCRIBE and replays nothing', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    await bus.subscribe(CHANNEL);
    const handler = vi.fn(async () => undefined);
    bus.onEvent(handler);

    redis.emit('message', CHANNEL, progressJson(1));
    await tick(10);
    expect(handler).toHaveBeenCalledTimes(1);

    // ioredis re-issues SUBSCRIBE for its own tracked channels; the gateway must
    // not add a second mechanism on top of it, and must not replay the event.
    redis.emit('close');
    redis.emit('reconnecting', 100);
    redis.emit('connect');
    redis.emit('ready');
    await tick(10);

    expect(redis.subscribeCalls).toEqual([CHANNEL]); // still exactly one
    expect(handler).toHaveBeenCalledTimes(1); // no replay
    await bus.close();
  });

  // @spec AC-5
  it('AC-5: after the last unsubscribe, a message still arriving on that channel is ignored', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    const handler = vi.fn(async () => undefined);
    bus.onEvent(handler);

    await bus.subscribe(CHANNEL);
    await bus.unsubscribe(CHANNEL);

    redis.emit('message', CHANNEL, progressJson(1));
    await tick(10);

    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });

  // @spec AC-1
  it('AC-1: the decoded event handed to the handler carries orgId/conversationId/turnId plus the push', async () => {
    const bus = await createChatEventBus(trackingFactory());
    const [redis] = instances;
    await bus.subscribe(CHANNEL);

    const events: unknown[] = [];
    bus.onEvent(async (event) => {
      events.push(event);
    });

    redis.emit('message', CHANNEL, progressJson(1));
    await tick(10);

    expect(events).toEqual([
      {
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        push: {
          type: 'chat.turn.progress',
          conversationId: CONVERSATION_ID,
          turnId: TURN_ID,
          seq: 1,
          kind: 'status',
          tool: null,
          detail: null,
          ts: TS,
        },
      },
    ]);
    await bus.close();
  });
});

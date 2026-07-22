import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { createGraphUpdatedBus, type RedisConnectionFactory } from './pubsub';

function validEnvelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message_id: 'm1',
    idempotency_key: 'm1',
    org_id: 'org-a',
    type: 'graph.updated',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    source: 'ingestion-worker',
    graph_scope_key: 'repo-1:main',
    graph_version: 1,
    payload: {
      repository_id: 'repo-1',
      ref_name: 'refs/heads/main',
      revision_sha: 'abc',
      full_rebuild: false,
      changed_paths: [],
      structural_duration_ms: 100,
    },
    ...overrides,
  });
}

class FakeRedis extends EventEmitter {
  published: Array<[string, string]> = [];
  subscribedChannels: string[] = [];
  quit = vi.fn(async () => 'OK');

  async publish(channel: string, message: string): Promise<number> {
    this.published.push([channel, message]);
    return 1;
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribedChannels.push(channel);
    return 1;
  }
}

afterEach(() => {
  resetConfigForTests();
});

describe('createGraphUpdatedBus', () => {
  it('creates two distinct connections (one subscriber, one publisher)', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'localhost');
    setConfigOverrideForTests('REDIS_PORT', '6379');
    const instances: FakeRedis[] = [];
    const factory: RedisConnectionFactory = () => {
      const instance = new FakeRedis();
      instances.push(instance);
      return instance as unknown as ReturnType<RedisConnectionFactory>;
    };

    const bus = await createGraphUpdatedBus('sayre:graph.updated', factory);

    expect(instances).toHaveLength(2);
    await bus.close();
  });

  it('publish() JSON-serializes the envelope onto the given channel via the publisher connection', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'localhost');
    setConfigOverrideForTests('REDIS_PORT', '6379');
    const instances: FakeRedis[] = [];
    const factory: RedisConnectionFactory = () => {
      const instance = new FakeRedis();
      instances.push(instance);
      return instance as unknown as ReturnType<RedisConnectionFactory>;
    };

    const bus = await createGraphUpdatedBus('sayre:graph.updated', factory);
    const [, publisher] = instances;

    const envelopeJson = validEnvelopeJson();
    await bus.publish(JSON.parse(envelopeJson));

    expect(publisher.published).toEqual([['sayre:graph.updated', envelopeJson]]);
    await bus.close();
  });

  it('subscribe() registers the channel and routes a valid incoming message to the handler', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'localhost');
    setConfigOverrideForTests('REDIS_PORT', '6379');
    const instances: FakeRedis[] = [];
    const factory: RedisConnectionFactory = () => {
      const instance = new FakeRedis();
      instances.push(instance);
      return instance as unknown as ReturnType<RedisConnectionFactory>;
    };

    const bus = await createGraphUpdatedBus('sayre:graph.updated', factory);
    const [subscriber] = instances;
    const handler = vi.fn(async () => undefined);

    await bus.subscribe(handler);
    expect(subscriber.subscribedChannels).toEqual(['sayre:graph.updated']);

    subscriber.emit('message', 'sayre:graph.updated', validEnvelopeJson());
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledTimes(1);
    await bus.close();
  });

  it('discards a malformed message without crashing and without invoking the handler', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'localhost');
    setConfigOverrideForTests('REDIS_PORT', '6379');
    const instances: FakeRedis[] = [];
    const factory: RedisConnectionFactory = () => {
      const instance = new FakeRedis();
      instances.push(instance);
      return instance as unknown as ReturnType<RedisConnectionFactory>;
    };

    const bus = await createGraphUpdatedBus('sayre:graph.updated', factory);
    const [subscriber] = instances;
    const handler = vi.fn(async () => undefined);
    await bus.subscribe(handler);

    subscriber.emit('message', 'sayre:graph.updated', 'not json');
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });

  it('ignores messages on a different channel', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'localhost');
    setConfigOverrideForTests('REDIS_PORT', '6379');
    const instances: FakeRedis[] = [];
    const factory: RedisConnectionFactory = () => {
      const instance = new FakeRedis();
      instances.push(instance);
      return instance as unknown as ReturnType<RedisConnectionFactory>;
    };

    const bus = await createGraphUpdatedBus('sayre:graph.updated', factory);
    const [subscriber] = instances;
    const handler = vi.fn(async () => undefined);
    await bus.subscribe(handler);

    subscriber.emit('message', 'some-other-channel', validEnvelopeJson());
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });

  it('close() quits both connections', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'localhost');
    setConfigOverrideForTests('REDIS_PORT', '6379');
    const instances: FakeRedis[] = [];
    const factory: RedisConnectionFactory = () => {
      const instance = new FakeRedis();
      instances.push(instance);
      return instance as unknown as ReturnType<RedisConnectionFactory>;
    };

    const bus = await createGraphUpdatedBus('sayre:graph.updated', factory);
    await bus.close();

    for (const instance of instances) {
      expect(instance.quit).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects when REDIS_PORT is out of range, mirroring services/core/src/queue/bullmq.ts', async () => {
    setConfigOverrideForTests('REDIS_HOST', 'localhost');
    setConfigOverrideForTests('REDIS_PORT', '99999');
    const factory: RedisConnectionFactory = () => new FakeRedis() as unknown as ReturnType<RedisConnectionFactory>;

    await expect(createGraphUpdatedBus('sayre:graph.updated', factory)).rejects.toThrow(/REDIS_PORT/);
  });
});

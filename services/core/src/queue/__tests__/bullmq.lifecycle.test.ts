import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redisInstances: [] as Array<{
    options: unknown;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  queueInstances: [] as Array<{
    name: string;
    options: unknown;
    close: ReturnType<typeof vi.fn>;
  }>,
  workerInstances: [] as Array<{
    name: string;
    processor: unknown;
    options: unknown;
    close: ReturnType<typeof vi.fn>;
  }>,
  onWorkerConstruct: null as (() => void) | null,
}));

vi.mock('ioredis', () => ({
  default: class MockRedis {
    readonly quit = vi.fn(async () => 'OK');
    readonly disconnect = vi.fn();

    constructor(readonly options: unknown) {
      mocks.redisInstances.push(this);
    }
  },
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly name: string,
      readonly options: unknown,
    ) {
      mocks.queueInstances.push(this);
    }
  },
  Worker: class MockWorker {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly name: string,
      readonly processor: unknown,
      readonly options: unknown,
    ) {
      mocks.workerInstances.push(this);
      mocks.onWorkerConstruct?.();
    }
  },
}));

import {
  resetSecretsForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import {
  QueueInitializationCancelledError,
  closeQueues,
  createWorker,
  getQueue,
  getRedisConnection,
} from '../bullmq';

const compileTimeWorkerOptions: NonNullable<Parameters<typeof createWorker>[2]> = {
  // @ts-expect-error -- createWorker exclusively owns the managed Redis connection.
  connection: {},
};
void compileTimeWorkerOptions;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  await closeQueues();
  resetSecretsForTests();
  mocks.redisInstances.length = 0;
  mocks.queueInstances.length = 0;
  mocks.workerInstances.length = 0;
  mocks.onWorkerConstruct = null;
});

afterEach(async () => {
  await closeQueues();
  vi.stubEnv('NODE_ENV', 'test');
  resetSecretsForTests();
  vi.unstubAllEnvs();
  mocks.onWorkerConstruct = null;
});

describe('BullMQ singleton lifecycle', () => {
  it('shares one Queue and one Redis connection across concurrent first callers', async () => {
    const release = deferred();
    let resolutions = 0;
    setSecretBackendForTests(async () => {
      resolutions += 1;
      await release.promise;
      return 'redis-password';
    });

    const first = getQueue('github-sync');
    const second = getQueue('github-sync');
    await vi.waitFor(() => expect(resolutions).toBe(1));
    expect(mocks.redisInstances).toHaveLength(0);
    expect(mocks.queueInstances).toHaveLength(0);

    release.resolve();
    const [firstQueue, secondQueue] = await Promise.all([first, second]);

    expect(firstQueue).toBe(secondQueue);
    expect(mocks.redisInstances).toHaveLength(1);
    expect(mocks.queueInstances).toHaveLength(1);

    await closeQueues();
    expect(mocks.queueInstances[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.redisInstances[0].quit).toHaveBeenCalledTimes(1);
  });

  it('cancels and closes initialization that resolves during shutdown, then can restart', async () => {
    const release = deferred();
    let resolutions = 0;
    setSecretBackendForTests(async () => {
      resolutions += 1;
      await release.promise;
      return 'redis-password';
    });

    const initialization = getQueue('jira-sync');
    const rejected = expect(initialization).rejects.toBeInstanceOf(
      QueueInitializationCancelledError,
    );
    await vi.waitFor(() => expect(resolutions).toBe(1));

    const shutdown = closeQueues();
    release.resolve();
    await rejected;
    await shutdown;

    expect(mocks.redisInstances).toHaveLength(1);
    expect(mocks.redisInstances[0].quit).toHaveBeenCalledTimes(1);
    expect(mocks.queueInstances).toHaveLength(0);

    const restarted = await getQueue('jira-sync');
    expect(restarted).toBeDefined();
    expect(mocks.redisInstances).toHaveLength(2);
    expect(mocks.queueInstances).toHaveLength(1);
  });

  it('cancels worker creation when shutdown wins the prewarmed Redis await boundary', async () => {
    setSecretBackendForTests(async () => 'redis-password');
    await getRedisConnection();
    expect(mocks.redisInstances).toHaveLength(1);

    const initialization = createWorker('linear-sync', async () => undefined);
    const rejected = expect(initialization).rejects.toBeInstanceOf(
      QueueInitializationCancelledError,
    );
    const shutdown = closeQueues();

    await rejected;
    await shutdown;
    expect(mocks.workerInstances).toHaveLength(0);
    expect(mocks.redisInstances[0].quit).toHaveBeenCalledTimes(1);
  });

  it('keeps the managed connection when a runtime cast supplies a connection override', async () => {
    setSecretBackendForTests(async () => 'redis-password');
    const callerConnection = { kind: 'caller-controlled-redis' };
    const runtimeOptions = {
      concurrency: 7,
      connection: callerConnection,
    } as unknown as NonNullable<Parameters<typeof createWorker>[2]>;

    const worker = await createWorker('linear-sync', async () => undefined, runtimeOptions);

    expect(mocks.redisInstances).toHaveLength(1);
    expect(mocks.workerInstances).toHaveLength(1);
    expect(mocks.workerInstances[0].options).toMatchObject({ concurrency: 7 });
    expect((mocks.workerInstances[0].options as { connection: unknown }).connection).toBe(
      mocks.redisInstances[0],
    );
    expect((mocks.workerInstances[0].options as { connection: unknown }).connection).not.toBe(
      callerConnection,
    );

    await (worker as unknown as { close: () => Promise<void> }).close();
    await closeQueues();
    expect(mocks.workerInstances[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.redisInstances[0].quit).toHaveBeenCalledTimes(1);
  });

  it('closes a worker constructed during reentrant shutdown and reports cancellation', async () => {
    setSecretBackendForTests(async () => 'redis-password');
    await getRedisConnection();
    const callerConnection = { kind: 'must-not-own-lifecycle' };
    const runtimeOptions = {
      connection: callerConnection,
    } as unknown as NonNullable<Parameters<typeof createWorker>[2]>;
    let shutdown: Promise<void> | undefined;
    mocks.onWorkerConstruct = () => {
      shutdown = closeQueues();
    };

    await expect(
      createWorker('github-sync', async () => undefined, runtimeOptions),
    ).rejects.toBeInstanceOf(QueueInitializationCancelledError);
    expect(shutdown).toBeDefined();
    await shutdown;

    expect(mocks.workerInstances).toHaveLength(1);
    expect((mocks.workerInstances[0].options as { connection: unknown }).connection).toBe(
      mocks.redisInstances[0],
    );
    expect((mocks.workerInstances[0].options as { connection: unknown }).connection).not.toBe(
      callerConnection,
    );
    expect(mocks.workerInstances[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.redisInstances[0].quit).toHaveBeenCalledTimes(1);
  });
});

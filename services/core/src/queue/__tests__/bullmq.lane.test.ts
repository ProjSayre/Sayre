// W0-04 (GAP-3a) — the broker-free half of the BullMQ lane mechanism.
//
// Canonical acceptance line: docs/product/Ticket-Backlog-by-Feature-2.md §W0-04
// ("cross-language test messages consumed correctly; a priority message demonstrably
// drains ahead of a backlog of default messages"). docs/backlog.md's shorter reword is
// superseded.
//
// Scope of THIS file: which BullMQ job option `enqueue()` emits for a lane, and which
// inputs it refuses. That is pure mapping/validation logic, so ioredis and bullmq are
// mocked here exactly the way bullmq.lifecycle.test.ts mocks them and no broker is
// required.
//
// Scope explicitly NOT here: what BullMQ then *does* with that option. A mock cannot
// prove `wait`-vs-`prioritized` placement or dequeue order and must never be read as
// having done so — that is bullmq.priority.test.ts, against a live Redis.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addCalls: [] as Array<{
    queue: string;
    jobName: string;
    data: unknown;
    options: Record<string, unknown> | undefined;
  }>,
}));

vi.mock('ioredis', () => ({
  default: class MockRedis {
    readonly quit = vi.fn(async () => 'OK');
    readonly disconnect = vi.fn();

    constructor(readonly options: unknown) {}
  },
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly name: string,
      readonly options: unknown,
    ) {}

    async add(jobName: string, data: unknown, options?: Record<string, unknown>) {
      mocks.addCalls.push({ queue: this.name, jobName, data, options });
      return { id: `job-${mocks.addCalls.length}` };
    }
  },
  Worker: class MockWorker {
    readonly close = vi.fn(async () => undefined);

    constructor(
      readonly name: string,
      readonly processor: unknown,
      readonly options: unknown,
    ) {}
  },
}));

import { resetSecretsForTests } from '@sayre/config';
import { EnvelopeValidationError, makeEnvelope, type MessageEnvelope } from '../envelope';
import * as bullmqModule from '../bullmq';
import { closeQueues, enqueue, type GithubSyncPayload } from '../bullmq';

// The lane surface does not exist yet, so it cannot be imported by name without making
// this module unloadable. Reading it off the namespace keeps every failure below an
// assertion failure (leading-red) rather than a link error.
const laneApi = bullmqModule as unknown as {
  JOB_LANES?: readonly string[];
  LANE_PRIORITY?: Record<string, number>;
  DEFAULT_JOB_LANE?: string;
};

// `enqueue`'s option type widens from JobsOptions to EnqueueOptions in this ticket;
// deriving it from the function keeps this file compiling on both sides of that change.
type EnqueueOpts = NonNullable<Parameters<typeof enqueue>[2]>;

function opts(value: Record<string, unknown>): EnqueueOpts {
  return value as unknown as EnqueueOpts;
}

function githubEnvelope(overrides: { org_id?: string } = {}): MessageEnvelope<GithubSyncPayload> {
  return makeEnvelope<GithubSyncPayload>({
    org_id: overrides.org_id ?? 'org_lane_test',
    type: 'repo.push',
    source: 'github-webhook',
    payload: {
      provider: 'github',
      type: 'push',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: 'inst-42',
      delivery_id: 'dlv-1',
      payload: {},
    },
  });
}

/** Bypasses makeEnvelope's own validation so enqueue() is the thing under test. */
function invalidEnvelope(): MessageEnvelope<GithubSyncPayload> {
  return {
    ...githubEnvelope(),
    org_id: '', // empty tenant context — must be refused before anything else
  };
}

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  await closeQueues();
  resetSecretsForTests();
  mocks.addCalls.length = 0;
});

afterEach(async () => {
  await closeQueues();
  resetSecretsForTests();
  vi.unstubAllEnvs();
});

describe('BullMQ job lanes (broker-free)', () => {
  // @spec AC-1
  it('AC-1: exports the two named lanes, a NON-ZERO BullMQ priority for each, and a default lane', () => {
    expect(laneApi.JOB_LANES).toBeDefined();
    expect([...(laneApi.JOB_LANES as readonly string[])]).toEqual(['priority', 'default']);

    expect(laneApi.LANE_PRIORITY).toBeDefined();
    expect(laneApi.LANE_PRIORITY).toEqual({ priority: 1, default: 2 });

    expect(laneApi.DEFAULT_JOB_LANE).toBe('default');

    // The whole mechanism turns on this: BullMQ routes a falsy priority to the
    // unprioritized `wait` list, which drains BEFORE `prioritized` is consulted.
    for (const [lane, priority] of Object.entries(laneApi.LANE_PRIORITY!)) {
      expect(priority, `lane "${lane}" must map to a non-zero priority`).toBeGreaterThan(0);
    }
    // Lower number = higher priority in BullMQ.
    expect(laneApi.LANE_PRIORITY!.priority).toBeLessThan(laneApi.LANE_PRIORITY!.default);
  });

  // @spec AC-1 EC-1
  it('AC-1/EC-1: an omitted lane resolves DEFAULT_JOB_LANE and still emits a non-zero priority', async () => {
    const jobId = await enqueue('github-sync', githubEnvelope());

    expect(jobId).toBeTruthy();
    expect(mocks.addCalls).toHaveLength(1);
    const jobOptions = mocks.addCalls[0].options ?? {};
    expect(jobOptions.priority).toBe(2);
    expect(jobOptions.priority).not.toBe(0);
    expect(jobOptions.priority).not.toBeUndefined();
    // Unchanged defaults from before this ticket.
    expect(jobOptions.attempts).toBe(1);
    expect(jobOptions.removeOnComplete).toBe(true);
    expect(mocks.addCalls[0].jobName).toBe('repo.push');
  });

  // @spec AC-1
  it('AC-1: lane: "priority" is passed through as BullMQ\'s native priority option', async () => {
    await enqueue('github-sync', githubEnvelope(), opts({ lane: 'priority' }));

    expect(mocks.addCalls).toHaveLength(1);
    expect((mocks.addCalls[0].options ?? {}).priority).toBe(1);
  });

  // @spec AC-1
  it('AC-1: caller options still pass through, and the lane priority is applied after them', async () => {
    await enqueue(
      'jira-sync',
      makeEnvelope({
        org_id: 'org_lane_test',
        type: 'jira.issue.updated',
        source: 'jira-webhook',
        payload: {
          provider: 'jira' as const,
          direction: 'inbound' as const,
          external_ticket_id: 'SAY-104',
          repository_id: 'repo-1',
          ref_name: 'refs/heads/main',
        },
      }),
      opts({ lane: 'priority', attempts: 3, removeOnComplete: false }),
    );

    const jobOptions = mocks.addCalls[0].options ?? {};
    expect(jobOptions.attempts).toBe(3);
    expect(jobOptions.removeOnComplete).toBe(false);
    expect(jobOptions.priority).toBe(1);
  });

  // @spec AC-3 EC-3
  it('AC-3/EC-3: an unknown lane throws, names lane and the valid set, and adds nothing', async () => {
    const rejected: unknown[] = ['urgent', '', 'PRIORITY', 3, null];

    for (const lane of rejected) {
      await expect(
        enqueue('github-sync', githubEnvelope(), opts({ lane })),
        `lane ${JSON.stringify(lane)} must be rejected`,
      ).rejects.toThrow(/lane/i);
    }

    // The rejection happens instead of the add, not alongside it.
    expect(mocks.addCalls).toHaveLength(0);
  });

  // @spec AC-3
  it('AC-3: a raw `priority` key on opts throws, naming lane as the supported mechanism, and adds nothing', async () => {
    for (const priority of [0, 1, 5, undefined]) {
      await expect(
        enqueue('github-sync', githubEnvelope(), opts({ priority })),
        `raw priority ${JSON.stringify(priority)} must be rejected`,
      ).rejects.toThrow(/lane/i);
    }

    expect(mocks.addCalls).toHaveLength(0);
  });

  // @spec EC-6
  it('EC-6: assertValidEnvelope runs BEFORE lane resolution — same rejection on every lane, nothing added', async () => {
    // An invalid envelope plus an invalid lane must fail on the envelope, not the lane:
    // that is what "envelope validation runs first" means observably.
    await expect(enqueue('github-sync', invalidEnvelope(), opts({ lane: 'urgent' }))).rejects.toBeInstanceOf(
      EnvelopeValidationError,
    );
    await expect(enqueue('github-sync', invalidEnvelope(), opts({ lane: 'priority' }))).rejects.toBeInstanceOf(
      EnvelopeValidationError,
    );
    await expect(enqueue('github-sync', invalidEnvelope())).rejects.toBeInstanceOf(
      EnvelopeValidationError,
    );
    expect(mocks.addCalls).toHaveLength(0);

    // ...and the priority lane it was rejected on is a real, working lane, so the
    // assertion above cannot be passing merely because lanes are ignored.
    await enqueue('github-sync', githubEnvelope(), opts({ lane: 'priority' }));
    expect(mocks.addCalls).toHaveLength(1);
    expect((mocks.addCalls[0].options ?? {}).priority).toBe(1);
  });
});

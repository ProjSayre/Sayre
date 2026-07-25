// Bounded background delivery for W1-06's transactional initial-parse outbox.
//
// At-least-once is intentional: a process may publish successfully and die
// before marking the row delivered. The exact committed envelope is retried
// with its deterministic FIFO idempotency key, and the Python consumer's
// durable idempotency store is the final duplicate guard.

import type { RepoInitialParseEvent } from '@sayre/shared-types';
import {
  claimInitialParseOutbox,
  completeInitialParseOutbox,
  retryInitialParseOutbox,
  type ClaimedInitialParseOutboxEvent,
} from '../db/githubInitialParseOutbox';
import { getRuntimeDb } from '../db/installations';
import type { MessageEnvelope } from '../queue/envelope';
import { publishInitialParseEvent } from '../queue/sqs';

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_LEASE_SECONDS = 90;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_SECONDS = 300;

export interface InitialParseOutboxDispatcherDeps {
  claim: (
    batchSize: number,
    leaseSeconds: number,
  ) => Promise<ClaimedInitialParseOutboxEvent[]>;
  complete: (id: string, leaseToken: string) => Promise<boolean>;
  retry: (id: string, leaseToken: string, delaySeconds: number) => Promise<boolean>;
  publish: (envelope: MessageEnvelope<RepoInitialParseEvent>) => Promise<unknown>;
  reportError: (stage: 'claim' | 'publish' | 'complete' | 'retry') => void;
}

export interface InitialParseOutboxDispatcherOptions {
  batchSize?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  publishTimeoutMs?: number;
}

export interface InitialParseOutboxDrainResult {
  claimed: number;
  delivered: number;
  deferred: number;
}

function defaultReportError(stage: 'claim' | 'publish' | 'complete' | 'retry'): void {
  // Never attach the raw error: provider/DB errors can contain repository
  // names, endpoints, DSNs, or credentials.
  console.error(`[core] initial-parse outbox ${stage} failed; delivery will retry`);
}

async function defaultClaim(
  batchSize: number,
  leaseSeconds: number,
): Promise<ClaimedInitialParseOutboxEvent[]> {
  return claimInitialParseOutbox(await getRuntimeDb(), batchSize, leaseSeconds);
}

async function defaultComplete(id: string, leaseToken: string): Promise<boolean> {
  return completeInitialParseOutbox(await getRuntimeDb(), id, leaseToken);
}

async function defaultRetry(
  id: string,
  leaseToken: string,
  delaySeconds: number,
): Promise<boolean> {
  return retryInitialParseOutbox(await getRuntimeDb(), id, leaseToken, delaySeconds);
}

const defaultDeps: InitialParseOutboxDispatcherDeps = {
  claim: defaultClaim,
  complete: defaultComplete,
  retry: defaultRetry,
  publish: publishInitialParseEvent,
  reportError: defaultReportError,
};

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function retryDelaySeconds(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 8);
  return Math.min(2 ** exponent, MAX_RETRY_DELAY_SECONDS);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Initial-parse outbox publish timed out.'));
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class InitialParseOutboxDispatcher {
  private readonly deps: InitialParseOutboxDispatcherDeps;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly publishTimeoutMs: number;
  private started = false;
  private runAfterCurrent = false;
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;

  constructor(
    deps: Partial<InitialParseOutboxDispatcherDeps> = {},
    options: InitialParseOutboxDispatcherOptions = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
    this.batchSize = boundedInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      'batchSize',
      1,
      25,
    );
    this.leaseSeconds = boundedInteger(
      options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      'leaseSeconds',
      10,
      300,
    );
    this.pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
      25,
      60_000,
    );
    this.publishTimeoutMs = boundedInteger(
      options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
      'publishTimeoutMs',
      25,
      this.leaseSeconds * 1_000 - 1,
    );
  }

  /** Start recovery immediately, including rows left by an earlier process. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /** Wake the already-started dispatcher after a callback commits new rows. */
  kick(): void {
    if (!this.started) return;
    if (this.activeRun) {
      this.runAfterCurrent = true;
      return;
    }
    this.schedule(0);
  }

  /** Stop claiming new work and wait for the bounded current cycle. */
  async stop(): Promise<void> {
    this.started = false;
    this.runAfterCurrent = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.activeRun;
  }

  /**
   * Claim and process one bounded batch. Exposed for focused tests and manual
   * recovery; the normal runtime calls it through start()/kick().
   */
  async drainOnce(): Promise<InitialParseOutboxDrainResult> {
    const claimed = await this.deps.claim(this.batchSize, this.leaseSeconds);
    let delivered = 0;
    let deferred = 0;

    // Sequential publishing preserves claim order for multiple revisions of
    // the same FIFO message group. The batch, timeout, and lease are all
    // bounded so a cycle cannot occupy a claim indefinitely.
    for (const event of claimed) {
      try {
        await withTimeout(
          Promise.resolve(this.deps.publish(event.envelope)),
          this.publishTimeoutMs,
        );
      } catch {
        this.deps.reportError('publish');
        deferred += 1;
        try {
          await this.deps.retry(
            event.id,
            event.leaseToken,
            retryDelaySeconds(event.attemptCount),
          );
        } catch {
          // Lease expiry is the final recovery path if this bookkeeping write
          // cannot reach Postgres.
          this.deps.reportError('retry');
        }
        continue;
      }

      try {
        if (await this.deps.complete(event.id, event.leaseToken)) {
          delivered += 1;
        } else {
          // The lease was superseded or already completed elsewhere. It is
          // not safe to count this process's bookkeeping as delivered.
          deferred += 1;
        }
      } catch {
        // The queue may already contain the message. Do not report it as
        // delivered until the durable mark succeeds; lease expiry safely
        // republishes the same envelope/idempotency key.
        this.deps.reportError('complete');
        deferred += 1;
      }
    }

    return { claimed: claimed.length, delivered, deferred };
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runScheduledCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private runScheduledCycle(): void {
    if (!this.started || this.activeRun) return;

    let claimedCount = 0;
    const run = this.drainOnce()
      .then((result) => {
        claimedCount = result.claimed;
      })
      .catch(() => {
        this.deps.reportError('claim');
      })
      .finally(() => {
        if (this.activeRun === run) this.activeRun = null;
        if (!this.started) return;
        const runImmediately = this.runAfterCurrent || claimedCount === this.batchSize;
        this.runAfterCurrent = false;
        this.schedule(runImmediately ? 0 : this.pollIntervalMs);
      });
    this.activeRun = run;
  }
}

let runtimeDispatcher: InitialParseOutboxDispatcher | null = null;

export function getInitialParseOutboxDispatcher(): InitialParseOutboxDispatcher {
  if (!runtimeDispatcher) {
    runtimeDispatcher = new InitialParseOutboxDispatcher();
  }
  return runtimeDispatcher;
}

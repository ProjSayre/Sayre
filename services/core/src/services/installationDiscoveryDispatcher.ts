// W7-01 (OQ-3): bounded background dispatch for the installation-discovery outbox. Structural
// copy of `initialParseOutboxDispatcher.ts` (bounded batch, lease, poll interval, publish
// timeout, sequential publish, timer `unref()`, `reportError` that never attaches the raw
// error), publishing via BullMQ `enqueue()` instead of SQS.
//
// Unlike 0012's terminal `delivered_at`, `complete()` here is a WATCHDOG RE-ARM (see
// db/githubInstallationDiscoveryOutbox.ts): a claimed row that publishes successfully is marked
// dispatched and its `next_attempt_at` is pushed forward by `redispatchSeconds`, so a run that
// stops progressing (heartbeat) becomes due again automatically — this is what survives a total
// Redis loss with no admin action (AC-20).

import {
  claimInstallationDiscoveryOutbox,
  completeInstallationDiscoveryOutbox,
  retryInstallationDiscoveryOutbox,
  type ClaimedInstallationDiscovery,
} from '../db/githubInstallationDiscoveryOutbox';
import { getRuntimeDb } from '../db/installations';
import { enqueue, type GithubInstallationDiscoveryPayload } from '../queue/bullmq';
import type { MessageEnvelope } from '../queue/envelope';
import { buildInstallationDiscoveryEnvelope } from './githubInstallationDiscoveryService';

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_SECONDS = 300;

export const INSTALLATION_DISCOVERY_REDISPATCH_SECONDS = 300; // == INSTALLATION_SYNC_STALL_MS
export const MAX_INSTALLATION_DISCOVERY_DISPATCH_ATTEMPTS = 10; // runaway guard (EC-27)

export interface InstallationDiscoveryDispatcherDeps {
  claim: (batchSize: number, leaseSeconds: number) => Promise<ClaimedInstallationDiscovery[]>;
  complete: (id: string, leaseToken: string, redispatchSeconds: number) => Promise<boolean>;
  retry: (id: string, leaseToken: string, delaySeconds: number) => Promise<boolean>;
  publish: (envelope: MessageEnvelope<GithubInstallationDiscoveryPayload>) => Promise<string>;
  reportError: (stage: 'claim' | 'publish' | 'complete' | 'retry') => void;
}

export interface InstallationDiscoveryDispatcherOptions {
  batchSize?: number; // default 5, 1..25
  leaseSeconds?: number; // default 60, 10..300
  pollIntervalMs?: number; // default 2_000, 25..60_000
  publishTimeoutMs?: number; // default 10_000, < leaseSeconds * 1000
  redispatchSeconds?: number; // default INSTALLATION_DISCOVERY_REDISPATCH_SECONDS
}

export interface InstallationDiscoveryDrainResult {
  claimed: number;
  dispatched: number;
  deferred: number;
}

function defaultReportError(stage: 'claim' | 'publish' | 'complete' | 'retry'): void {
  // Never attach the raw error: provider/DB/Redis errors can contain repository names,
  // endpoints, DSNs, or credentials.
  console.error(`[core] installation discovery outbox ${stage} failed; dispatch will retry`);
}

async function defaultClaim(
  batchSize: number,
  leaseSeconds: number,
): Promise<ClaimedInstallationDiscovery[]> {
  return claimInstallationDiscoveryOutbox(await getRuntimeDb(), batchSize, leaseSeconds);
}

async function defaultComplete(
  id: string,
  leaseToken: string,
  redispatchSeconds: number,
): Promise<boolean> {
  return completeInstallationDiscoveryOutbox(await getRuntimeDb(), id, leaseToken, redispatchSeconds);
}

async function defaultRetry(id: string, leaseToken: string, delaySeconds: number): Promise<boolean> {
  return retryInstallationDiscoveryOutbox(await getRuntimeDb(), id, leaseToken, delaySeconds);
}

async function defaultPublish(
  envelope: MessageEnvelope<GithubInstallationDiscoveryPayload>,
): Promise<string> {
  return enqueue('github-sync', envelope, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}

const defaultDeps: InstallationDiscoveryDispatcherDeps = {
  claim: defaultClaim,
  complete: defaultComplete,
  retry: defaultRetry,
  publish: defaultPublish,
  reportError: defaultReportError,
};

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function retryDelaySeconds(dispatchAttemptCount: number): number {
  const exponent = Math.min(Math.max(dispatchAttemptCount - 1, 0), 8);
  return Math.min(2 ** exponent, MAX_RETRY_DELAY_SECONDS);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Installation discovery outbox publish timed out.'));
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

export class InstallationDiscoveryDispatcher {
  private readonly deps: InstallationDiscoveryDispatcherDeps;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly publishTimeoutMs: number;
  private readonly redispatchSeconds: number;
  private started = false;
  private runAfterCurrent = false;
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;

  constructor(
    deps: Partial<InstallationDiscoveryDispatcherDeps> = {},
    options: InstallationDiscoveryDispatcherOptions = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
    this.batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, 25);
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
    this.redispatchSeconds = boundedInteger(
      options.redispatchSeconds ?? INSTALLATION_DISCOVERY_REDISPATCH_SECONDS,
      'redispatchSeconds',
      30,
      3_600,
    );
  }

  /** Start recovery immediately, including rows left by an earlier process. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /** Wake the already-started dispatcher after a callback/reconcile commits new rows. */
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
   * Claim and process one bounded batch. Exposed for focused tests and manual recovery; the
   * normal runtime calls it through start()/kick().
   */
  async drainOnce(): Promise<InstallationDiscoveryDrainResult> {
    const claimed = await this.deps.claim(this.batchSize, this.leaseSeconds);
    let dispatched = 0;
    let deferred = 0;

    // Sequential publishing, same rationale as the initial-parse dispatcher: the batch, timeout,
    // and lease are all bounded so a cycle cannot occupy a claim indefinitely.
    for (const row of claimed) {
      const envelope = buildInstallationDiscoveryEnvelope({
        orgId: row.orgId,
        installationId: row.installationId,
        runId: row.runId,
        reason: row.reason,
      });

      try {
        await withTimeout(Promise.resolve(this.deps.publish(envelope)), this.publishTimeoutMs);
      } catch {
        this.deps.reportError('publish');
        deferred += 1;
        try {
          await this.deps.retry(row.id, row.leaseToken, retryDelaySeconds(row.dispatchAttemptCount));
        } catch {
          // Lease expiry is the final recovery path if this bookkeeping write cannot reach
          // Postgres.
          this.deps.reportError('retry');
        }
        continue;
      }

      try {
        if (await this.deps.complete(row.id, row.leaseToken, this.redispatchSeconds)) {
          dispatched += 1;
        } else {
          // The lease was superseded or the row moved on elsewhere. Not safe to count this
          // process's bookkeeping as dispatched.
          deferred += 1;
        }
      } catch {
        // The queue may already contain the message (at-least-once). Do not report it as
        // dispatched until the durable watchdog re-arm succeeds; lease expiry safely
        // redispatches the same run/idempotency key.
        this.deps.reportError('complete');
        deferred += 1;
      }
    }

    return { claimed: claimed.length, dispatched, deferred };
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

let runtimeDispatcher: InstallationDiscoveryDispatcher | null = null;

export function getInstallationDiscoveryDispatcher(): InstallationDiscoveryDispatcher {
  if (!runtimeDispatcher) {
    runtimeDispatcher = new InstallationDiscoveryDispatcher();
  }
  return runtimeDispatcher;
}

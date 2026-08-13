// Leading-red tests (W7-01) for InstallationDiscoveryDispatcher — mirrors
// InitialParseOutboxDispatcher.test.ts's conventions exactly, since spec.md's Approach step 6
// says this class is a structural copy of that one (bounded batch, lease, poll interval, publish
// timeout, sequential publish), publishing via BullMQ enqueue() instead of SQS, plus the
// watchdog-style completeInstallationDiscoveryOutbox re-arm semantics (AC-20/AC-23) that its SQS
// counterpart doesn't have. The class does not exist yet, so every test fails today with a
// module-resolution error (RED-CORRECT).

import { describe, expect, it, vi } from 'vitest';

const INSTALLATION_ID = 555;
const RUN_ID = '22222222-2222-4222-8222-222222222222';

interface ClaimedInstallationDiscovery {
  id: string;
  leaseToken: string;
  orgId: string;
  installationId: number;
  runId: string;
  reason: 'app_install' | 'manual_reconcile';
  dispatchAttemptCount: number;
}

function claim(overrides: Partial<ClaimedInstallationDiscovery> = {}): ClaimedInstallationDiscovery {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    leaseToken: '00000000-0000-4000-8000-000000000011',
    orgId: '11111111-1111-4111-8111-111111111111',
    installationId: INSTALLATION_ID,
    runId: RUN_ID,
    reason: 'app_install',
    dispatchAttemptCount: 1,
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    claim: vi.fn(async () => [claim()]),
    complete: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    publish: vi.fn(async () => 'bullmq-job-id'),
    reportError: vi.fn(),
    ...overrides,
  };
}

async function loadDispatcher() {
  return import('./installationDiscoveryDispatcher');
}

describe('InstallationDiscoveryDispatcher — AC-19/AC-20 (outbox-first dispatch, claim -> publish -> complete)', () => {
  // @spec AC-19
  it('publishes the envelope for a claimed row before marking it complete (re-armed, not terminal)', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const calls: string[] = [];
    const event = claim();
    const injected = deps({
      claim: vi.fn(async () => [event]),
      publish: vi.fn(async () => {
        calls.push('publish');
        return 'job-id';
      }),
      complete: vi.fn(async () => {
        calls.push('complete');
        return true;
      }),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({ claimed: 1, dispatched: 1, deferred: 0 });
    expect(calls).toEqual(['publish', 'complete']);
    expect(injected.retry).not.toHaveBeenCalled();
  });

  // @spec AC-20
  it('total Redis loss recovery: re-claims a stalled row and republishes with the SAME run_id/idempotency-bearing envelope', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const event = claim({ dispatchAttemptCount: 2 });
    let publishedEnvelope: unknown;
    const injected = deps({
      claim: vi.fn(async () => [event]),
      publish: vi.fn(async (envelope: unknown) => {
        publishedEnvelope = envelope;
        return 'job-id-2';
      }),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    await dispatcher.drainOnce();

    expect(publishedEnvelope).toMatchObject({
      payload: expect.objectContaining({ run_id: RUN_ID, installation_id: String(INSTALLATION_ID) }),
    });
  });
});

describe('InstallationDiscoveryDispatcher — AC-21 (bounded, lossless failure handling)', () => {
  // @spec AC-21
  it('a failed publish() releases the lease with backoff, never marking complete', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const injected = deps({
      claim: vi.fn(async () => [claim({ dispatchAttemptCount: 3 })]),
      publish: vi.fn(async () => {
        throw new Error('Redis unreachable');
      }),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({ claimed: 1, dispatched: 0, deferred: 1 });
    expect(injected.complete).not.toHaveBeenCalled();
    expect(injected.retry).toHaveBeenCalled();
    expect(injected.reportError).toHaveBeenCalledWith('publish');
  });

  // @spec AC-21
  it('a lost completion lease (complete() returns false — superseded) counts as deferred, not dispatched', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const injected = deps({ complete: vi.fn(async () => false) });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({ claimed: 1, dispatched: 0, deferred: 1 });
  });
});

describe('InstallationDiscoveryDispatcher — AC-23 (heartbeat: complete() re-arms next_attempt_at)', () => {
  // @spec AC-23
  it('calls complete(id, leaseToken, redispatchSeconds) with INSTALLATION_DISCOVERY_REDISPATCH_SECONDS', async () => {
    const service = await loadDispatcher();
    const event = claim();
    const injected = deps({ claim: vi.fn(async () => [event]) });
    const dispatcher = new service.InstallationDiscoveryDispatcher(injected);

    await dispatcher.drainOnce();

    expect(injected.complete).toHaveBeenCalledWith(
      event.id,
      event.leaseToken,
      service.INSTALLATION_DISCOVERY_REDISPATCH_SECONDS,
    );
    expect(service.INSTALLATION_DISCOVERY_REDISPATCH_SECONDS).toBe(300);
  });
});

describe('InstallationDiscoveryDispatcher — EC-9 (BullMQ enqueue fails right after the row committed)', () => {
  // @spec EC-9
  it('a publish failure right after commit still leaves the row claimable, dispatch_attempt_count effectively advanced by a later claim, no manual reconcile needed', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const injected = deps({
      claim: vi.fn(async () => [claim({ dispatchAttemptCount: 1 })]),
      publish: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      retry: vi.fn(async () => true),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    const result = await dispatcher.drainOnce();

    expect(result.deferred).toBe(1);
    expect(injected.retry).toHaveBeenCalledOnce();
    // Never logs the raw provider/Redis error text.
    expect(injected.reportError).toHaveBeenCalledWith('publish');
  });
});

describe('InstallationDiscoveryDispatcher — EC-20/EC-24 (stalled run redispatch resumes, no duplicate work)', () => {
  // @spec EC-24
  it('redispatches the same run_id for a row whose heartbeat stopped advancing, rather than minting a new one', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const stalledEvent = claim({ dispatchAttemptCount: 4 });
    let published: unknown;
    const injected = deps({
      claim: vi.fn(async () => [stalledEvent]),
      publish: vi.fn(async (envelope: unknown) => {
        published = envelope;
        return 'job-id';
      }),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    await dispatcher.drainOnce();

    expect((published as { payload: { run_id: string } }).payload.run_id).toBe(stalledEvent.runId);
  });
});

describe('InstallationDiscoveryDispatcher — EC-23 (Redis unavailable for the whole window)', () => {
  // @spec EC-23
  it('every claim/publish cycle defers with backoff when Redis is down, nothing lost or double-counted', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const injected = deps({
      claim: vi.fn(async () => [claim(), claim({ id: 'row-2', leaseToken: 'lease-2' })]),
      publish: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    const result = await dispatcher.drainOnce();

    expect(result).toEqual({ claimed: 2, dispatched: 0, deferred: 2 });
    expect(injected.retry).toHaveBeenCalledTimes(2);
  });
});

describe('InstallationDiscoveryDispatcher — EC-26 (dispatcher dies after enqueue succeeded, before completion mark)', () => {
  // @spec EC-26
  it('a completion write failure after a successful publish is deferred, not counted dispatched — at-least-once, never a silent loss', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    const injected = deps({
      complete: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected);

    const result = await dispatcher.drainOnce();

    expect(result).toEqual({ claimed: 1, dispatched: 0, deferred: 1 });
    expect(injected.reportError).toHaveBeenCalledWith('complete');
  });
});

describe('InstallationDiscoveryDispatcher — EC-27 (permanently undispatchable row: bounded attempts)', () => {
  // @spec EC-27
  it('exports MAX_INSTALLATION_DISCOVERY_DISPATCH_ATTEMPTS = 10 as the runaway guard', async () => {
    const service = await loadDispatcher();
    expect(service.MAX_INSTALLATION_DISCOVERY_DISPATCH_ATTEMPTS).toBe(10);
  });
});

describe('InstallationDiscoveryDispatcher — EC-28 (start/kick/stop lifecycle: immediate recovery claim)', () => {
  // @spec EC-28
  it('start() performs an immediate recovery claim and stop() waits for it to finish', async () => {
    const { InstallationDiscoveryDispatcher } = await loadDispatcher();
    let signalClaim!: () => void;
    const claimed = new Promise<void>((resolve) => {
      signalClaim = resolve;
    });
    const injected = deps({
      claim: vi.fn(async () => {
        signalClaim();
        return [];
      }),
    });
    const dispatcher = new InstallationDiscoveryDispatcher(injected, { pollIntervalMs: 25 });

    dispatcher.start();
    await claimed;
    await dispatcher.stop();

    expect(injected.claim).toHaveBeenCalledOnce();
  });
});

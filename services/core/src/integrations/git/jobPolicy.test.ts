// W3-04 gapfill (GAP-4). Leading-red coverage for the exported retry/backoff/retention
// policy object spec.md's Interfaces section pins exactly:
//   { attempts: 5, backoff: { type: 'exponential', delay: 1_000 }, removeOnFail: false }
//
// The behavioral half of GAP-4 (a transient failure is actually retried by BullMQ, an
// exhausted job stays in the `failed` set, the worker's failed listener records only
// org/provider/delivery/attempt/error-name) needs a real Redis-backed queue/worker and
// is covered by __tests__/jobRetry.integration.test.ts instead (RED-DEFERRED here).
//
// Broker-free: imports only.

import { describe, expect, it } from 'vitest';

describe('GIT_SYNC_JOB_OPTIONS (GAP-4)', () => {
  // @spec AC-7
  it('retries a transient failure up to 5 attempts with exponential backoff and retains an exhausted job', async () => {
    const { GIT_SYNC_JOB_OPTIONS } = await import('./jobPolicy');
    expect(GIT_SYNC_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnFail: false,
    });
  });
});

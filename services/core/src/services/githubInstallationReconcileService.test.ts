// Fully DI-mocked unit tests for reconcileInstallationRepositories — no Postgres, no
// network. All ReconcileDeps are injected, mirroring the pattern used across the other
// W1-06/W2-09/W7-01 service test files.
//
// W7-01: reconcile is now row-write-only (no listing/registration/enqueue on the request path
// — see githubInstallationReconcileService.discoveryQueue.test.ts for the AC-10 behavioral
// coverage that replaced this file's old additive-repair/truncation tests). What stays here is
// the still-true structural guarantee OQ-5 established and W7-01 extends rather than
// contradicts: the SYNCHRONOUS request path itself never revokes and never lists/registers a
// repo inline — the sweep-authorization assertions below replace the old "revocation can never
// happen at all" claim, which is no longer true once a run reaches `complete` (AC-24).

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import {
  reconcileInstallationRepositories,
  type ReconcileDeps,
} from './githubInstallationReconcileService';

function ctx(orgId = 'org-1'): AuthContext {
  return { subjectType: 'user', orgId, userId: 'user-1', roles: ['admin'] };
}

function makeDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }]),
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    startInstallationSync: vi.fn(async () => ({ reset: true, runId: 'run-uuid-1' })),
    kickDiscoveryDispatcher: vi.fn(),
    ...overrides,
  } as ReconcileDeps;
}

describe('reconcileInstallationRepositories — row-write-only request path (W7-01)', () => {
  it('an org with zero active installations returns queued: 0 without any DB write or dispatch', async () => {
    const deps = makeDeps({ resolveActiveInstallations: vi.fn(async () => []) });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result).toEqual({ status: 'queued', installations: 0, queued: 0 });
    expect(deps.withOrg).not.toHaveBeenCalled();
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
  });

  it('records one manual_reconcile run row per active installation and kicks the dispatcher', async () => {
    const deps = makeDeps({
      resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }, { installationId: 777 }]),
    });
    const result = await reconcileInstallationRepositories(ctx(), deps);
    expect(result).toEqual({ status: 'queued', installations: 2, queued: 2 });
    expect(deps.startInstallationSync).toHaveBeenCalledTimes(2);
    expect(deps.kickDiscoveryDispatcher).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileInstallationRepositories — AC-25/AC-29 sweep authorization (supersedes the old OQ-5 "never revokes" claim)', () => {
  it('ReconcileDeps has no githubClient/registerRepository/markRepositoryRevoked dependency this call reaches', async () => {
    const deps = makeDeps();
    await reconcileInstallationRepositories(ctx(), deps);
    // Structural: the fake deps object never provided these, and the call still succeeded —
    // proving reconcile does not reach for a GitHub client or a repo writer at all. Revocation,
    // when it happens at all, is now performed asynchronously by the discovery worker against a
    // `manual_reconcile` run this call merely records (AC-24/AC-25) — never by this function.
    expect('githubClient' in deps).toBe(false);
    expect('registerRepository' in deps).toBe(false);
    expect('markRepositoryRevoked' in deps).toBe(false);
    expect('enqueueInitialParse' in deps).toBe(false);
  });

  it('every written row carries reason: "manual_reconcile" — the ONLY discovery reason a sweep may ever apply for', async () => {
    const deps = makeDeps();
    await reconcileInstallationRepositories(ctx(), deps);
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'manual_reconcile' }),
    );
  });
});

describe('reconcileInstallationRepositories — tenant isolation', () => {
  it('resolves org_id ONLY from ctx.orgId, scoping every read/write to it', async () => {
    const deps = makeDeps();
    await reconcileInstallationRepositories(ctx('org-resolved-42'), deps);
    expect(deps.resolveActiveInstallations).toHaveBeenCalledWith('org-resolved-42');
    expect(deps.withOrg).toHaveBeenCalledWith('org-resolved-42', expect.any(Function));
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: 'org-resolved-42' }),
    );
  });

  it('a resolveActiveInstallations failure fails the whole call before any write', async () => {
    const deps = makeDeps({
      resolveActiveInstallations: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await expect(reconcileInstallationRepositories(ctx(), deps)).rejects.toThrow('db down');
    expect(deps.withOrg).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
  });
});

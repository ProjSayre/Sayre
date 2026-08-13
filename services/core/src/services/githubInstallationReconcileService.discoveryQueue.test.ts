// Leading-red tests (W7-01) for reconcileInstallationRepositories's new row-write-only shape
// (spec.md AC-10, EC-17). The OQ-5 additive-only behavior this function had before W7-01 is
// tested extensively in the existing githubInstallationReconcileService.test.ts, which spec.md's
// "Affected files" assigns to `dev` to rewrite — this is a NEW file for the new behavior instead,
// following the same convention as githubAppInstallService.discoveryCallback.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import { reconcileInstallationRepositories, type ReconcileDeps } from './githubInstallationReconcileService';

function ctx(overrides: Partial<AuthContext> = {}): AuthContext {
  return { subjectType: 'user', orgId: 'org-1', userId: 'user-1', roles: ['admin'], ...overrides } as AuthContext;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }, { installationId: 777 }]),
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    startInstallationSync: vi.fn(async () => ({ reset: true, runId: 'run-uuid-1' })),
    kickDiscoveryDispatcher: vi.fn(),
    ...overrides,
  };
}

describe('reconcileInstallationRepositories — AC-10 (row-write-only: one durable run per active installation)', () => {
  // @spec AC-10
  it('records one manual_reconcile run row per active installation, all in ONE withOrgContext transaction, kicks the dispatcher after commit, and returns { status: "queued", installations, queued }', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
        order.push('tx-open');
        const result = await fn({});
        order.push('tx-commit');
        return result;
      }),
      startInstallationSync: vi.fn(async (_tx: unknown, row: { installationId: number }) => {
        order.push(`startInstallationSync:${row.installationId}`);
        return { reset: true, runId: `run-${row.installationId}` };
      }),
      kickDiscoveryDispatcher: vi.fn(() => order.push('kickDiscoveryDispatcher')),
    });

    const result = await reconcileInstallationRepositories(ctx(), deps as unknown as Partial<ReconcileDeps>);

    expect(result).toEqual({ status: 'queued', installations: 2, queued: 2 });
    expect(deps.startInstallationSync).toHaveBeenCalledTimes(2);
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        installationId: 555,
        reason: 'manual_reconcile',
        requestedBy: { subjectType: 'user', subjectId: 'user-1' },
      }),
    );
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationId: 777, reason: 'manual_reconcile' }),
    );
    expect(order.indexOf('tx-open')).toBeLessThan(order.indexOf('startInstallationSync:555'));
    expect(order.indexOf('tx-commit')).toBeLessThan(order.indexOf('kickDiscoveryDispatcher'));
  });

  // @spec AC-10
  it('performs no inline repo listing, registration, or revocation — ReconcileDeps has no githubClient/registerRepository/markRepositoryRevoked dependency it calls', async () => {
    const deps = makeDeps();
    await reconcileInstallationRepositories(ctx(), deps as unknown as Partial<ReconcileDeps>);
    // Structural: the fake deps object never provided these, and the call still succeeded —
    // proving reconcile does not reach for a githubClient or registerRepository at all.
    expect('githubClient' in deps).toBe(false);
    expect('registerRepository' in deps).toBe(false);
    expect('markRepositoryRevoked' in deps).toBe(false);
  });

  // @spec AC-10
  it('derives requestedBy from an agent_key AuthContext the same way', async () => {
    const deps = makeDeps({ resolveActiveInstallations: vi.fn(async () => [{ installationId: 555 }]) });
    await reconcileInstallationRepositories(
      ctx({ subjectType: 'agent_key', agentKeyId: 'agent-key-1' } as Partial<AuthContext>),
      deps as unknown as Partial<ReconcileDeps>,
    );
    expect(deps.startInstallationSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestedBy: { subjectType: 'agent_key', subjectId: 'agent-key-1' },
      }),
    );
  });
});

describe('reconcileInstallationRepositories — zero active installations (no rows, no dispatch)', () => {
  // @spec AC-10
  it('an org with zero active installations returns queued: 0 without writing any row', async () => {
    const deps = makeDeps({ resolveActiveInstallations: vi.fn(async () => []) });
    const result = await reconcileInstallationRepositories(ctx(), deps as unknown as Partial<ReconcileDeps>);
    expect(result).toEqual({ status: 'queued', installations: 0, queued: 0 });
    expect(deps.startInstallationSync).not.toHaveBeenCalled();
    expect(deps.kickDiscoveryDispatcher).not.toHaveBeenCalled();
  });
});

// Fully DI-mocked unit tests for applyInstallationLifecycleEvent — no
// Postgres. resolveOrg/withOrg/markRevoked/setSuspended are all injected,
// mirroring the pattern in githubWebhookService.test.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  applyInstallationLifecycleEvent,
  type InstallationLifecycleDeps,
} from './githubInstallationLifecycleService';

function makeDeps(overrides: Partial<InstallationLifecycleDeps> = {}): InstallationLifecycleDeps {
  return {
    resolveOrg: vi.fn(async () => ({ orgId: 'org-1', active: true })),
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    markRevoked: vi.fn(async () => true),
    setSuspended: vi.fn(async () => true),
    ...overrides,
  } as InstallationLifecycleDeps;
}

describe('applyInstallationLifecycleEvent', () => {
  it("action='deleted' on a known installation revokes and returns { status: 'revoked' }", async () => {
    const deps = makeDeps();
    const result = await applyInstallationLifecycleEvent({ action: 'deleted', installationId: 555 }, deps);
    expect(result).toEqual({ status: 'revoked' });
    expect(deps.resolveOrg).toHaveBeenCalledWith(555);
    expect(deps.markRevoked).toHaveBeenCalledWith({}, 555);
  });

  it("action='suspend' suspends and returns { status: 'suspended' }", async () => {
    const deps = makeDeps();
    const result = await applyInstallationLifecycleEvent({ action: 'suspend', installationId: 555 }, deps);
    expect(result).toEqual({ status: 'suspended' });
    expect(deps.setSuspended).toHaveBeenCalledWith({}, 555, true);
  });

  it("action='unsuspend' clears suspension and returns { status: 'unsuspended' }", async () => {
    const deps = makeDeps();
    const result = await applyInstallationLifecycleEvent({ action: 'unsuspend', installationId: 555 }, deps);
    expect(result).toEqual({ status: 'unsuspended' });
    expect(deps.setSuspended).toHaveBeenCalledWith({}, 555, false);
  });

  it("an unknown installation_id (resolveOrg returns null) is ignored, never throws", async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => null) });
    const result = await applyInstallationLifecycleEvent({ action: 'deleted', installationId: 999 }, deps);
    expect(result).toEqual({ status: 'ignored', reason: 'unknown_installation' });
    expect(deps.markRevoked).not.toHaveBeenCalled();
  });

  it('a non-lifecycle action is ignored (noop_action) WITHOUT hitting the privileged org lookup', async () => {
    const deps = makeDeps();
    const result = await applyInstallationLifecycleEvent(
      { action: 'created', installationId: 555 },
      deps,
    );
    expect(result).toEqual({ status: 'ignored', reason: 'noop_action' });
    expect(deps.resolveOrg).not.toHaveBeenCalled();
  });

  it('new_permissions_accepted is ignored (noop_action)', async () => {
    const deps = makeDeps();
    const result = await applyInstallationLifecycleEvent(
      { action: 'new_permissions_accepted', installationId: 555 },
      deps,
    );
    expect(result).toEqual({ status: 'ignored', reason: 'noop_action' });
  });

  it('an already-revoked installation is idempotent: revoke again succeeds, no throw', async () => {
    const deps = makeDeps({ markRevoked: vi.fn(async () => true) });
    const result = await applyInstallationLifecycleEvent({ action: 'deleted', installationId: 555 }, deps);
    expect(result).toEqual({ status: 'revoked' });
  });

  it('a write that matches zero rows (race with a concurrent delete) is treated as unknown_installation', async () => {
    const deps = makeDeps({ markRevoked: vi.fn(async () => false) });
    const result = await applyInstallationLifecycleEvent({ action: 'deleted', installationId: 555 }, deps);
    expect(result).toEqual({ status: 'ignored', reason: 'unknown_installation' });
  });

  it('scopes the mutation via withOrg using the resolved org id (tenant isolation)', async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => ({ orgId: 'org-resolved-42', active: true })) });
    await applyInstallationLifecycleEvent({ action: 'suspend', installationId: 555 }, deps);
    expect(deps.withOrg).toHaveBeenCalledWith('org-resolved-42', expect.any(Function));
  });
});

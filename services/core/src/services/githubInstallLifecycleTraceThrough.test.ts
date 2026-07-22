// Tester-added coverage (W1-06 AC5 / edge case "After revoke, a push webhook
// for a repo under that installation ... ignored/revoked_installation,
// nothing enqueued"). githubWebhookService.test.ts and
// githubInstallationLifecycle.test.ts each cover their own service in
// isolation with independent DI mocks; neither, by itself, proves the two
// actually compose end-to-end: that revoking via `applyInstallationLifecycleEvent`
// produces exactly the state `resolveOrg` needs to read back in order to halt
// a later `handleGithubWebhook` call for the SAME installation.
//
// This test wires both services together against one shared in-memory
// "installations table" fake (no real Postgres, no Redis, no SQS) so the
// revoke -> later-event-halts chain is actually exercised, not just assumed
// from reading both files.

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { applyInstallationLifecycleEvent } from './githubInstallationLifecycleService';
import { handleGithubWebhook, type WebhookDeps } from './githubWebhookService';

const SECRET = 'wh-secret';

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function installationDeletedBody(installationId: number): Buffer {
  return Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: installationId } }));
}

function pushBody(installationId: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      installation: { id: installationId },
      repository: { id: 42, full_name: 'acme/widgets' },
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      forced: false,
      deleted: false,
      pusher: { name: 'octocat' },
      commits: [],
    }),
  );
}

/** A minimal shared fake standing in for the `github_app_installations` table. */
function makeFakeInstallationsTable() {
  const rows = new Map<number, { orgId: string; suspendedAt: Date | null; revokedAt: Date | null }>();

  return {
    seed(installationId: number, orgId: string) {
      rows.set(installationId, { orgId, suspendedAt: null, revokedAt: null });
    },
    // Shared by BOTH services under test, exactly like the real
    // `resolveInstallationOrg` (db/installations.ts) is shared by both in prod.
    resolveOrg: vi.fn(async (installationId: number) => {
      const row = rows.get(installationId);
      if (!row) return null;
      return { orgId: row.orgId, active: row.suspendedAt === null && row.revokedAt === null };
    }),
    // Mirrors markInstallationRevoked's COALESCE-idempotent semantics.
    markRevoked: vi.fn(async (_tx: unknown, installationId: number) => {
      const row = rows.get(installationId);
      if (!row) return false;
      if (row.revokedAt === null) row.revokedAt = new Date();
      return true;
    }),
    setSuspended: vi.fn(async () => true),
    withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
}

describe('W1-06 AC5 — installation.deleted halts later sync processing (trace-through)', () => {
  it('a push webhook delivered AFTER installation.deleted for the same installation is ignored/revoked_installation, nothing enqueued', async () => {
    const table = makeFakeInstallationsTable();
    table.seed(555, 'org-1');

    // Step 1: uninstall webhook arrives and revokes.
    const lifecycleResult = await applyInstallationLifecycleEvent(
      { action: 'deleted', installationId: 555 },
      {
        resolveOrg: table.resolveOrg,
        withOrg: table.withOrg,
        markRevoked: table.markRevoked,
        setSuspended: table.setSuspended,
      },
    );
    expect(lifecycleResult).toEqual({ status: 'revoked' });

    // Step 2: a LATER push webhook for the same installation must halt —
    // resolveOrg now reads back active:false from the SAME backing store the
    // revoke just wrote to.
    const publishIngestion = vi.fn(async () => undefined);
    const publishOwnership = vi.fn(async () => undefined);
    const deps: WebhookDeps = {
      getWebhookSecret: async () => SECRET,
      resolveOrg: table.resolveOrg,
      publishIngestion,
      publishOwnership,
      applyInstallationLifecycle: async (input) =>
        applyInstallationLifecycleEvent(input, {
          resolveOrg: table.resolveOrg,
          withOrg: table.withOrg,
          markRevoked: table.markRevoked,
          setSuspended: table.setSuspended,
        }),
    };

    const body = pushBody(555);
    const outcome = await handleGithubWebhook(
      { rawBody: body, signature: sign(body), githubEvent: 'push', deliveryId: 'd-after-revoke' },
      deps,
    );

    expect(outcome).toEqual({ status: 'ignored', reason: 'revoked_installation' });
    expect(publishIngestion).not.toHaveBeenCalled();
    expect(publishOwnership).not.toHaveBeenCalled();
  });

  it('does not throw, and never moves revokedAt forward, when installation.deleted is redelivered after the push halts', async () => {
    const table = makeFakeInstallationsTable();
    table.seed(555, 'org-1');
    await applyInstallationLifecycleEvent(
      { action: 'deleted', installationId: 555 },
      { resolveOrg: table.resolveOrg, withOrg: table.withOrg, markRevoked: table.markRevoked, setSuspended: table.setSuspended },
    );

    const body = installationDeletedBody(555);
    const redeliveredResult = await handleGithubWebhook(
      { rawBody: body, signature: sign(body), githubEvent: 'installation', deliveryId: 'd-redelivered' },
      {
        getWebhookSecret: async () => SECRET,
        resolveOrg: table.resolveOrg,
        publishIngestion: vi.fn(async () => undefined),
        publishOwnership: vi.fn(async () => undefined),
        applyInstallationLifecycle: async (input) =>
          applyInstallationLifecycleEvent(input, {
            resolveOrg: table.resolveOrg,
            withOrg: table.withOrg,
            markRevoked: table.markRevoked,
            setSuspended: table.setSuspended,
          }),
      },
    );

    expect(redeliveredResult).toEqual({ status: 'installation', result: { status: 'revoked' } });
  });

  it('an unknown installation_id never seen before is ignored end-to-end for both a deleted event and a later push', async () => {
    const table = makeFakeInstallationsTable(); // installation 999 never seeded

    const lifecycleResult = await applyInstallationLifecycleEvent(
      { action: 'deleted', installationId: 999 },
      { resolveOrg: table.resolveOrg, withOrg: table.withOrg, markRevoked: table.markRevoked, setSuspended: table.setSuspended },
    );
    expect(lifecycleResult).toEqual({ status: 'ignored', reason: 'unknown_installation' });

    const body = pushBody(999);
    const outcome = await handleGithubWebhook(
      { rawBody: body, signature: sign(body), githubEvent: 'push', deliveryId: 'd-unknown' },
      {
        getWebhookSecret: async () => SECRET,
        resolveOrg: table.resolveOrg,
        publishIngestion: vi.fn(async () => undefined),
        publishOwnership: vi.fn(async () => undefined),
        applyInstallationLifecycle: vi.fn(),
      },
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'unknown_installation' });
  });
});

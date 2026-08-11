// Tester-owned, fixture-driven end-to-end coverage for POST /webhooks/github.
//
// Unlike routes/githubWebhook.test.ts (dev's own inline-body HTTP tests), this suite
// replays the captured fixtures in webhooks/__fixtures__/ (push, pull_request, branch
// create/delete, ping, unsupported, tag-create, malformed-repository, a second
// installation) through a real createApp() + real HTTP server, signing each fixture's
// exact raw bytes at replay time. Only the DB installation lookup and the two queue
// publishers are mocked — signature verification, JSON parsing, and normalization all
// run for real, so this independently verifies O-1 routing, AC4 (tampered payload
// rejection), AC5 (server-resolved org_id), and AC6 (installation-lifecycle gating)
// against data this suite owns, not data the implementation shipped with.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import { loadFixture, signFixture, type WebhookFixture } from '../webhooks/__fixtures__/loadFixture';

const SECRET = 'fixture-replay-secret';

// Mocked at the db/installations module boundary — real signature is
// (db: Db, installationId: number), matching services/core/src/db/installations.ts.
const resolveInstallationOrg = vi.fn(async (_db: unknown, installationId: number) =>
  installationId === 777 ? { orgId: 'org-second-777', active: true } : { orgId: 'org-primary-555', active: true },
);
const getRuntimeDb = vi.fn(async () => ({}) as never);
vi.mock('../db/installations', () => ({
  resolveInstallationOrg: (...args: unknown[]) =>
    (resolveInstallationOrg as unknown as (...a: unknown[]) => unknown)(...args),
  getRuntimeDb: (...args: unknown[]) => (getRuntimeDb as unknown as (...a: unknown[]) => unknown)(...args),
}));

const publishIngestionEvent = vi.fn(async () => 'sqs-message-id');
vi.mock('../queue/sqs', () => ({
  INGESTION_QUEUE: 'ingestion.fifo',
  publishIngestionEvent: (...args: unknown[]) =>
    (publishIngestionEvent as unknown as (...a: unknown[]) => unknown)(...args),
}));

const enqueue = vi.fn(async () => 'bullmq-job-id');
vi.mock('../queue/bullmq', () => ({
  QUEUE_NAMES: ['github-sync', 'jira-sync', 'linear-sync'],
  enqueue: (...args: unknown[]) => (enqueue as unknown as (...a: unknown[]) => unknown)(...args),
}));

// W2-09: mocked at the service-layer boundary (mirrors routes/githubInstall.test.ts's
// treatment of handleGithubAppCallback) — the deep added/removed business logic (envelope
// construction, registerRepository/markRepositoryRevoked semantics, idempotency) is unit-
// tested directly against injected fakes in services/githubInstallationRepositoriesService.test.ts.
// This suite instead proves the HTTP/signature/parsing wiring: real signature verification,
// real parseInstallationRepositoriesEvent parsing, and correct outcome -> HTTP status mapping.
const applyInstallationRepositoriesEvent = vi.fn(async () => ({
  status: 'added' as const,
  registered: 1,
  enqueued: 1,
}));
vi.mock('../services/githubInstallationRepositoriesService', async () => {
  const actual = await vi.importActual<
    typeof import('../services/githubInstallationRepositoriesService')
  >('../services/githubInstallationRepositoriesService');
  return {
    ...actual,
    applyInstallationRepositoriesEvent: (...args: unknown[]) =>
      (applyInstallationRepositoriesEvent as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

import { createApp } from '../app';

async function startServer() {
  const app = createApp();
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let activeServer: Server | undefined;

beforeEach(() => {
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://GITHUB_WEBHOOK_SECRET') return SECRET;
    throw new Error(`unexpected secret ref in fixture test: ${ref}`);
  });
  resolveInstallationOrg.mockClear();
  publishIngestionEvent.mockClear();
  publishIngestionEvent.mockResolvedValue('sqs-message-id');
  enqueue.mockClear();
  enqueue.mockResolvedValue('bullmq-job-id');
  applyInstallationRepositoriesEvent.mockClear();
  applyInstallationRepositoriesEvent.mockResolvedValue({ status: 'added', registered: 1, enqueued: 1 });
});

afterEach(async () => {
  resetSecretsForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

async function replay(baseUrl: string, fixture: WebhookFixture, opts?: { signature?: string }) {
  const signature = opts?.signature ?? signFixture(fixture.rawBody, SECRET);
  return fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      ...fixture.headers,
    },
    body: fixture.rawBody,
  });
}

describe('POST /webhooks/github — replayed fixtures (O-1 routing)', () => {
  it('push.json publishes to BOTH ingestion (SQS) and ownership (BullMQ), returns 202', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(publishIngestionEvent).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    const [ingestionEnvelope] = publishIngestionEvent.mock.calls[0] as [
      { type: string; source: string; org_id: string; payload: Record<string, unknown> },
    ];
    expect(ingestionEnvelope.type).toBe('repo.push');
    expect(ingestionEnvelope.source).toBe('github-webhook');
    expect(ingestionEnvelope.payload).toMatchObject({
      provider: 'github',
      type: 'push',
      ref: 'refs/heads/main',
      repo: { provider_repo_id: '583231', full_name: 'acme-corp/widgets' },
    });

    const [ownershipEnvelope] = enqueue.mock.calls[0] as [string, { org_id: string }];
    void ownershipEnvelope;
  });

  it('push.branch-deletion.json (deleted:true, all-zero after) still normalizes and publishes to both, payload.deleted reflected', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.branch-deletion.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [envelope] = publishIngestionEvent.mock.calls[0] as [
      { payload: { payload: { deleted: boolean; after: string } } },
    ];
    expect(envelope.payload.payload.deleted).toBe(true);
    expect(envelope.payload.payload.after).toBe('0'.repeat(40));
  });

  it('pull_request.opened.json publishes to ownership (BullMQ) ONLY, not ingestion, returns 202', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('pull_request.opened.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, envelope] = enqueue.mock.calls[0] as [string, { payload: { ref: string | null; type: string } }];
    expect(envelope.payload.type).toBe('pull_request');
    expect(envelope.payload.ref).toBe('feature-x');
  });

  it('pull_request.opened.no-head-ref.json normalizes ref: null, still ownership only', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('pull_request.opened.no-head-ref.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, envelope] = enqueue.mock.calls[0] as [string, { payload: { ref: string | null } }];
    expect(envelope.payload.ref).toBeNull();
  });

  // GAP-8: branch create/delete no longer routes to ingestion (see
  // webhooks/normalizeGithubEvent.ts) -- a branch event carries no revision SHA,
  // so publishing it to the FIFO ingestion queue produced a permanently-failing
  // delivery that head-of-line blocked every later delta for the same ref group.
  // @spec AC-1 EC-26
  it('branch.create.json publishes to ownership ONLY (not ingestion), returns 202', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('branch.create.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, envelope] = enqueue.mock.calls[0] as [
      string,
      { payload: { type: string; ref: string; payload: Record<string, unknown> } },
    ];
    expect(envelope.payload.type).toBe('branch');
    expect(envelope.payload.ref).toBe('refs/heads/feature-y');
    expect(envelope.payload.payload).toEqual({ action: 'created', ref: 'feature-y', ref_type: 'branch' });
  });

  // @spec AC-1 EC-26
  it('branch.delete.json publishes to ownership ONLY (not ingestion), returns 202', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('branch.delete.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, envelope] = enqueue.mock.calls[0] as [
      string,
      { payload: { payload: Record<string, unknown> } },
    ];
    expect(envelope.payload.payload).toEqual({ action: 'deleted', ref: 'feature-y', ref_type: 'branch' });
  });

  it('tag.create.json (ref_type: tag) is ignored (unsupported_ref_type), 200, no publish', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('tag.create.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unsupported_ref_type' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ping.json is ignored, 200, no publish', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('ping.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'ping' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('unsupported.star.json is ignored, 200, no publish', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('unsupported.star.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unsupported_event' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('push.malformed-repository.json (missing repository.id/full_name) returns 400, no publish', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.malformed-repository.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(400);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/github — committed ingestion envelope fixtures (GAP-10, AC-4)', () => {
  // Deep-compares the LIVE envelope this route hands to publishIngestionEvent
  // against the committed queue/__fixtures__ files
  // (services/core/src/queue/__fixtures__/repo_push.envelope.json and
  // repo_push.branch-deletion.envelope.json), which
  // services/workers/tests/test_push_wire_fixture.py independently loads on the
  // Python side. A drift in Core's normalizer's wire shape fails on both sides.
  // Only message_id/occurred_at are excluded (volatile per-delivery fields);
  // trace_id/idempotency_key are the fixture's own pinned delivery id, so those
  // ARE compared.
  //
  // The committed fixtures pin org_id to the same synthetic tenant UUID
  // repo_initial_parse.envelope.json already uses (EC-9) -- this file's default
  // resolveInstallationOrg mock resolves installation 555 to "org-primary-555"
  // (used by every other test in this file), so these two tests override it
  // per-call to the synthetic id, exactly like the existing
  // "an empty resolved org_id" / "a suspended/revoked installation" tests below
  // already override it per-call for their own purposes.
  const FIXTURE_ORG_ID = '22222222-2222-4222-8222-222222222222';

  function omitVolatileFields(envelope: Record<string, unknown>): Record<string, unknown> {
    const volatile = new Set(['message_id', 'occurred_at']);
    return Object.fromEntries(Object.entries(envelope).filter(([key]) => !volatile.has(key)));
  }

  // @spec AC-4
  it('the envelope published for push.json matches the committed repo_push.envelope.json field-for-field', async () => {
    resolveInstallationOrg.mockImplementationOnce(async () => ({ orgId: FIXTURE_ORG_ID, active: true }));
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await replay(baseUrl, fixture);
    expect(res.status).toBe(202);

    const [publishedEnvelope] = publishIngestionEvent.mock.calls[0] as [Record<string, unknown>];
    const committedPath = join(
      __dirname,
      '..',
      'queue',
      '__fixtures__',
      'repo_push.envelope.json',
    );
    const committed = JSON.parse(readFileSync(committedPath, 'utf8')) as Record<string, unknown>;

    expect(omitVolatileFields(publishedEnvelope)).toEqual(omitVolatileFields(committed));
  });

  // @spec AC-4
  it('the envelope published for push.branch-deletion.json matches the committed repo_push.branch-deletion.envelope.json field-for-field', async () => {
    resolveInstallationOrg.mockImplementationOnce(async () => ({ orgId: FIXTURE_ORG_ID, active: true }));
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.branch-deletion.json');

    const res = await replay(baseUrl, fixture);
    expect(res.status).toBe(202);

    const [publishedEnvelope] = publishIngestionEvent.mock.calls[0] as [Record<string, unknown>];
    const committedPath = join(
      __dirname,
      '..',
      'queue',
      '__fixtures__',
      'repo_push.branch-deletion.envelope.json',
    );
    const committed = JSON.parse(readFileSync(committedPath, 'utf8')) as Record<string, unknown>;

    expect(omitVolatileFields(publishedEnvelope)).toEqual(omitVolatileFields(committed));
  });

  // @spec EC-9
  it('both committed fixtures carry the same synthetic tenant id as repo_initial_parse.envelope.json and no secret material', () => {
    const fixturesDir = join(__dirname, '..', 'queue', '__fixtures__');
    for (const name of ['repo_push.envelope.json', 'repo_push.branch-deletion.envelope.json']) {
      const raw = readFileSync(join(fixturesDir, name), 'utf8');
      const parsed = JSON.parse(raw) as { org_id: string };
      expect(parsed.org_id).toBe('22222222-2222-4222-8222-222222222222');
      const lowered = raw.toLowerCase();
      for (const forbidden of ['installation_token', 'clone_url', 'credential', 'x-access-token', 'password']) {
        expect(lowered).not.toContain(forbidden);
      }
    }
  });
});

describe('POST /webhooks/github — replayed installation_repositories fixtures (W2-09)', () => {
  it('installation_repositories.added.json delegates to applyInstallationRepositoriesEvent and enqueues, returns 200', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('installation_repositories.added.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(applyInstallationRepositoriesEvent).toHaveBeenCalledTimes(1);
    expect(applyInstallationRepositoriesEvent).toHaveBeenCalledWith({
      action: 'added',
      installationId: 555,
      added: [{ providerRepoId: '583232', fullName: 'acme-corp/new-repo' }],
      removed: [],
    });
    // Never delegates to the normalize -> resolve-org -> publish path.
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('installation_repositories.removed.json delegates to applyInstallationRepositoriesEvent, returns 200', async () => {
    applyInstallationRepositoriesEvent.mockResolvedValueOnce({ status: 'removed', revoked: 1 });
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('installation_repositories.removed.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(applyInstallationRepositoriesEvent).toHaveBeenCalledWith({
      action: 'removed',
      installationId: 555,
      added: [],
      removed: [{ providerRepoId: '583231', fullName: 'acme-corp/widgets' }],
    });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('replaying installation_repositories.added.json twice (GitHub retry) calls the service twice with the identical parsed input, both 200', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('installation_repositories.added.json');

    const first = await replay(baseUrl, fixture);
    const second = await replay(baseUrl, fixture);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(applyInstallationRepositoriesEvent).toHaveBeenCalledTimes(2);
    expect(applyInstallationRepositoriesEvent.mock.calls[0]).toEqual(applyInstallationRepositoriesEvent.mock.calls[1]);
  });

  it('a bad signature on installation_repositories.added.json is rejected 401 before any parse/delegate', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('installation_repositories.added.json');

    const res = await replay(baseUrl, fixture, { signature: 'sha256=' + '0'.repeat(64) });

    expect(res.status).toBe(401);
    expect(applyInstallationRepositoriesEvent).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/github — tampered-signature fixture (AC4)', () => {
  it('a fixture signed correctly but replayed with mismatched bytes (tampered after signing) returns 401, no publish', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const original = loadFixture('push.json');
    const tampered = loadFixture('push.branch-deletion.json'); // different bytes entirely

    // Sign the ORIGINAL fixture's bytes, but send the TAMPERED fixture's bytes —
    // simulates a delivery whose body was altered in transit/at-rest after GitHub
    // computed its signature over the real bytes.
    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signFixture(original.rawBody, SECRET),
        ...original.headers,
      },
      body: tampered.rawBody,
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid signature');
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a fixture replayed with a wrong secret\'s signature returns 401, no publish', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await replay(baseUrl, fixture, {
      signature: signFixture(fixture.rawBody, 'not-the-real-webhook-secret'),
    });

    expect(res.status).toBe(401);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a fixture replayed with no signature header at all returns 401, no publish', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...fixture.headers },
      body: fixture.rawBody,
    });

    expect(res.status).toBe(401);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/github — tenant isolation across replayed fixtures (AC5, AC6)', () => {
  it('org_id on the published envelope is the installation-resolved value, never the forged organization/org_id in push.json', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json'); // body carries organization.id + org_id "forged" claims

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(202);
    const [envelope] = publishIngestionEvent.mock.calls[0] as [{ org_id: string }];
    expect(envelope.org_id).toBe('org-primary-555');
    expect(envelope.org_id).not.toMatch(/forged/);
  });

  it('two different installations (555 vs 777) resolve to two different org_ids, no cross-tenant bleed', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const first = loadFixture('push.json'); // installation 555
    const second = loadFixture('push.second-installation.json'); // installation 777

    await replay(baseUrl, first);
    await replay(baseUrl, second);

    expect(publishIngestionEvent).toHaveBeenCalledTimes(2);
    const [envelopeA] = publishIngestionEvent.mock.calls[0] as [{ org_id: string }];
    const [envelopeB] = publishIngestionEvent.mock.calls[1] as [{ org_id: string }];
    expect(envelopeA.org_id).toBe('org-primary-555');
    expect(envelopeB.org_id).toBe('org-second-777');
    expect(envelopeA.org_id).not.toBe(envelopeB.org_id);
  });

  it('an empty resolved org_id (should be impossible) is rejected before any queue call — surfaces as 500, not a silent 2xx', async () => {
    resolveInstallationOrg.mockImplementationOnce(async () => ({ orgId: '', active: true }));
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(500);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('an unknown installation id (no resolver row) is ignored 200, no publish', async () => {
    resolveInstallationOrg.mockImplementationOnce(async () => null);
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unknown_installation' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a suspended/revoked installation is ignored 200, no publish', async () => {
    resolveInstallationOrg.mockImplementationOnce(async () => ({ orgId: 'org-primary-555', active: false }));
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await replay(baseUrl, fixture);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'revoked_installation' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/github — replay/idempotency (AC9)', () => {
  it('replaying the identical push.json delivery twice yields two publishes with the same idempotency_key', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    await replay(baseUrl, fixture);
    await replay(baseUrl, fixture);

    expect(publishIngestionEvent).toHaveBeenCalledTimes(2);
    const [first] = publishIngestionEvent.mock.calls[0] as [{ idempotency_key: string }];
    const [second] = publishIngestionEvent.mock.calls[1] as [{ idempotency_key: string }];
    expect(first.idempotency_key).toBe(fixture.headers['x-github-delivery']);
    expect(second.idempotency_key).toBe(fixture.headers['x-github-delivery']);
    expect(first.idempotency_key).toBe(second.idempotency_key);
  });
});

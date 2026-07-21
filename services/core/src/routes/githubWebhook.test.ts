// HTTP-level tests for POST /webhooks/github via a real createApp() + real HTTP
// server (no supertest dependency — matches the pattern in routes/technicalTree.test.ts).
//
// Only the service's infra-touching collaborators are mocked (DB installation lookup,
// SQS publish, BullMQ enqueue) — signature verification, JSON parsing, and event
// normalization all run for real, so this exercises the actual route -> service ->
// webhooks/* code paths end to end without touching Redis/SQS/Postgres.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';

const SECRET = 'route-test-secret';

const resolveInstallationOrg = vi.fn(async () => ({ orgId: 'org-resolved-1', active: true }));
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

import { createApp } from '../app';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function pushBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      installation: { id: 555 },
      repository: { id: 42, full_name: 'acme/widgets' },
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      forced: false,
      deleted: false,
      pusher: { name: 'octocat' },
      commits: [],
      ...overrides,
    }),
  );
}

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
    throw new Error(`unexpected secret ref in route test: ${ref}`);
  });
  resolveInstallationOrg.mockClear();
  resolveInstallationOrg.mockResolvedValue({ orgId: 'org-resolved-1', active: true });
  publishIngestionEvent.mockClear();
  publishIngestionEvent.mockResolvedValue('sqs-message-id');
  enqueue.mockClear();
  enqueue.mockResolvedValue('bullmq-job-id');
});

afterEach(async () => {
  resetSecretsForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

async function post(baseUrl: string, body: Buffer, headers: Record<string, string>) {
  return fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('POST /webhooks/github', () => {
  it('AC2: a validly signed push returns 202 and publishes to both ingestion and ownership', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-1',
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(publishIngestionEvent).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('AC4: a missing signature header returns 401 and publishes nothing', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-2',
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid signature');
    expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('AC4: a tampered body (bytes differ from what was signed) returns 401 and publishes nothing', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const signedBody = pushBody({ ref: 'refs/heads/original' });
    const tamperedBody = pushBody({ ref: 'refs/heads/tampered' });

    const res = await post(baseUrl, tamperedBody, {
      'x-hub-signature-256': sign(signedBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-3',
    });

    expect(res.status).toBe(401);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
  });

  it('a sha1-only X-Hub-Signature (no -256) returns 401', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();
    const sha1 = createHmac('sha1', SECRET).update(rawBody).digest('hex');

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature': `sha1=${sha1}`,
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-4',
    });

    expect(res.status).toBe(401);
  });

  it('a valid signature but non-JSON body returns 400', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = Buffer.from('not json');

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-5',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad request' });
  });

  it('a valid signature but missing X-GitHub-Event returns 400', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-delivery': 'delivery-6',
    });

    expect(res.status).toBe(400);
  });

  it('a valid signature but missing X-GitHub-Delivery returns 400', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
    });

    expect(res.status).toBe(400);
  });

  it('ping returns 200 { ok: true, ignored: "ping" } and publishes nothing', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = Buffer.from(JSON.stringify({ zen: 'hello', hook_id: 1 }));

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'ping',
      'x-github-delivery': 'delivery-7',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'ping' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('an unsupported event (star) returns 200 ignored and publishes nothing', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = Buffer.from(JSON.stringify({ installation: { id: 555 } }));

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'star',
      'x-github-delivery': 'delivery-8',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unsupported_event' });
  });

  it('AC3: pull_request publishes to ownership only and returns 202', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = Buffer.from(
      JSON.stringify({
        installation: { id: 555 },
        repository: { id: 42, full_name: 'acme/widgets' },
        action: 'opened',
        number: 1,
        pull_request: {
          id: 1,
          state: 'open',
          merged: false,
          title: 'x',
          head: { ref: 'feature', sha: 'h' },
          base: { ref: 'main', sha: 'b' },
          user: { login: 'octocat', id: 1 },
        },
      }),
    );

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-9',
    });

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('AC6: an unknown installation returns 200 ignored and publishes nothing', async () => {
    resolveInstallationOrg.mockResolvedValueOnce(null);
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-10',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unknown_installation' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a revoked installation returns 200 ignored and publishes nothing', async () => {
    resolveInstallationOrg.mockResolvedValueOnce({ orgId: 'org-1', active: false });
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-11',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'revoked_installation' });
  });

  it('AC5: a forged organization/org_id claim in the body does not reach the published envelope org_id', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody({ organization: { id: 'forged' }, org_id: 'forged-org-id' });

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-12',
    });

    expect(res.status).toBe(202);
    const [envelope] = publishIngestionEvent.mock.calls[0] as [{ org_id: string }];
    expect(envelope.org_id).toBe('org-resolved-1');
  });

  it('AC7: the webhook secret is resolved via the loader only — 500 when it is unavailable, no publish', async () => {
    setSecretBackendForTests(async () => {
      throw new Error('Secret GITHUB_WEBHOOK_SECRET is missing.');
    });
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-13',
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toMatch(/GITHUB_WEBHOOK_SECRET/);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
  });

  it('a publish failure (ownership queue down) surfaces as 500, not a partial 2xx', async () => {
    enqueue.mockRejectedValueOnce(new Error('redis unreachable'));
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-14',
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(JSON.stringify(body)).not.toMatch(/redis unreachable/);
  });

  it('AC10: the SQS-bound envelope serializes with snake_case keys and no extra keys', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();

    await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-15',
    });

    const [envelope] = publishIngestionEvent.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(envelope).sort()).toEqual(
      [
        'message_id',
        'idempotency_key',
        'org_id',
        'type',
        'schema_version',
        'occurred_at',
        'source',
        'trace_id',
        'payload',
      ].sort(),
    );
  });

  it('AC9: replaying the identical signed delivery reaches the handler with the same X-GitHub-Delivery-derived idempotency key', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();
    const headers = {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-replay',
    };

    await post(baseUrl, rawBody, headers);
    await post(baseUrl, rawBody, headers);

    expect(publishIngestionEvent).toHaveBeenCalledTimes(2);
    const [first] = publishIngestionEvent.mock.calls[0] as [{ idempotency_key: string }];
    const [second] = publishIngestionEvent.mock.calls[1] as [{ idempotency_key: string }];
    expect(first.idempotency_key).toBe('delivery-replay');
    expect(second.idempotency_key).toBe('delivery-replay');
  });

  it('oversized body (> 5mb) returns 413 and publishes nothing', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(oversized),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-16',
      },
      body: oversized,
    });

    expect(res.status).toBe(413);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
  }, 20_000);
});

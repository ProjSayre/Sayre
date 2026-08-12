// Red-stage (W1-02 gapfill) HTTP-level coverage through a real createApp() + real HTTP
// server, with only the DB installation lookup and the two queue clients mocked at the
// module boundary — so the BullMQ call this suite asserts is the real
// `enqueue('github-sync', envelope, { jobId: envelope.idempotency_key })` binding from
// githubWebhookService's defaultDeps, not an injected fake.
//
// Covers AC-5/EC-17 (the BullMQ half of "replayed fixtures produce correct queue
// messages", previously asserted by nothing), AC-1/EC-2 at the wire level, AC-2/EC-5,
// AC-4/EC-14, and EC-18.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import { loadFixture, signFixture } from '../webhooks/__fixtures__/loadFixture';

const SECRET = 'gapfill-route-secret';

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

function expectedKey(rawBody: Buffer): string {
  return `github:webhook:${createHash('sha256').update(rawBody).digest('hex')}`;
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
    throw new Error(`unexpected secret ref in gapfill route test: ${ref}`);
  });
  resolveInstallationOrg.mockClear();
  resolveInstallationOrg.mockResolvedValue({ orgId: 'org-resolved-1', active: true });
  getRuntimeDb.mockClear();
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

describe('POST /webhooks/github — the BullMQ ownership binding is measured (AC-5 / GAP-8)', () => {
  // @spec AC-5 EC-17
  it('replaying push.json binds enqueue to (github-sync, the exact envelope, { jobId: envelope.idempotency_key })', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.json');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signFixture(fixture.rawBody, SECRET),
        ...fixture.headers,
      },
      body: fixture.rawBody,
    });

    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(publishIngestionEvent).toHaveBeenCalledTimes(1);

    const [ingestionEnvelope] = publishIngestionEvent.mock.calls[0] as [
      { idempotency_key: string },
    ];
    const [queueName, ownershipEnvelope, options] = enqueue.mock.calls[0] as [
      string,
      { idempotency_key: string },
      Record<string, unknown>,
    ];

    expect(queueName).toBe('github-sync');
    // Same object identity, not merely a structural twin.
    expect(ownershipEnvelope).toBe(ingestionEnvelope);
    expect(options).toEqual({ jobId: ownershipEnvelope.idempotency_key });
    expect(ownershipEnvelope.idempotency_key).toBe(expectedKey(fixture.rawBody));
  });

  // @spec AC-1 AC-5 EC-2
  it('two deliveries of the same bytes under different X-GitHub-Delivery headers share one BullMQ jobId', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody();
    const signature = sign(rawBody);

    await post(baseUrl, rawBody, {
      'x-hub-signature-256': signature,
      'x-github-event': 'push',
      'x-github-delivery': 'genuine-1',
    });
    await post(baseUrl, rawBody, {
      'x-hub-signature-256': signature,
      'x-github-event': 'push',
      'x-github-delivery': 'attacker-2',
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    const [, firstEnvelope, firstOptions] = enqueue.mock.calls[0] as [
      string,
      { trace_id: string },
      { jobId: string },
    ];
    const [, secondEnvelope, secondOptions] = enqueue.mock.calls[1] as [
      string,
      { trace_id: string },
      { jobId: string },
    ];

    expect(firstOptions.jobId).toBe(expectedKey(rawBody));
    expect(secondOptions.jobId).toBe(firstOptions.jobId);
    expect(firstEnvelope.trace_id).toBe('genuine-1');
    expect(secondEnvelope.trace_id).toBe('attacker-2');
  });

  // @spec EC-18
  it('pull_request produces exactly one github-sync enqueue and zero ingestion publishes', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('pull_request.opened.json');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signFixture(fixture.rawBody, SECRET),
        ...fixture.headers,
      },
      body: fixture.rawBody,
    });

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [queueName, envelope, options] = enqueue.mock.calls[0] as [
      string,
      { idempotency_key: string },
      Record<string, unknown>,
    ];
    expect(queueName).toBe('github-sync');
    expect(options).toEqual({ jobId: envelope.idempotency_key });
    expect(envelope.idempotency_key).toBe(expectedKey(fixture.rawBody));
  });
});

describe('POST /webhooks/github — tag pushes are ignored at the wire level (AC-2 / GAP-5)', () => {
  // @spec AC-2 EC-5
  it('a validly-signed push on refs/tags/v1.0.0 returns 200 unsupported_ref_type with no queue call', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody({ ref: 'refs/tags/v1.0.0' });

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-tag',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unsupported_ref_type' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  // @spec AC-2 EC-5
  it('the committed push.tag.json fixture replays to 200 unsupported_ref_type with no queue call', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.tag.json');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signFixture(fixture.rawBody, SECRET),
        ...fixture.headers,
      },
      body: fixture.rawBody,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unsupported_ref_type' });
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  // @spec AC-2 EC-7
  it('a push on refs/heads/feat/a/b is unaffected — 202 to both destinations', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody({ ref: 'refs/heads/feat/a/b' });

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-nested',
    });

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('POST /webhooks/github — malformed repository.full_name is a 400 (AC-4 / GAP-7)', () => {
  // @spec AC-4 EC-14
  it.each(['../../evil', 'a/b/c', 'owner/', '/name', 'owner//name'])(
    'a push whose full_name is %j returns 400 with no publish to either queue',
    async (fullName) => {
      const { server, baseUrl } = await startServer();
      activeServer = server;
      const rawBody = pushBody({ repository: { id: 42, full_name: fullName } });

      const res = await post(baseUrl, rawBody, {
        'x-hub-signature-256': sign(rawBody),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-badname',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad request' });
      expect(publishIngestionEvent).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  // @spec AC-4 EC-14
  it('the committed push.malformed-full-name.json fixture replays to 400 with no queue call', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const fixture = loadFixture('push.malformed-full-name.json');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signFixture(fixture.rawBody, SECRET),
        ...fixture.headers,
      },
      body: fixture.rawBody,
    });

    expect(res.status).toBe(400);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  // @spec AC-4 EC-15
  it('an ordinary full_name (acme-corp/widgets) is still accepted', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = pushBody({ repository: { id: 42, full_name: 'acme-corp/widgets' } });

    const res = await post(baseUrl, rawBody, {
      'x-hub-signature-256': sign(rawBody),
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-goodname',
    });

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).toHaveBeenCalledTimes(1);
  });
});

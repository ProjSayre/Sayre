// Red-stage (W1-02 gapfill, GAP-9 / AC-6) coverage for the raw-body cap decision.
//
// Kept in its own file because every test here depends on the not-yet-existing
// `GITHUB_WEBHOOK_MAX_BODY_BYTES` export — isolating it means the AC-5/AC-2/AC-4 route
// tests in githubWebhook.gapfill.test.ts fail for their OWN reasons rather than for a
// missing import in a shared module graph.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';

const SECRET = 'body-cap-secret';

// The cap the ticket decides to KEEP. Body sizes below are built from this literal
// rather than from the imported constant, so the enforcement tests exercise the real
// 5 MB boundary independently of whether the export exists yet — only the two tests in
// the first describe block are about the export itself.
const EXPECTED_MAX_BODY_BYTES = 5 * 1024 * 1024;

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
import { GITHUB_WEBHOOK_MAX_BODY_BYTES } from './githubWebhook';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
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

/** A valid push body padded to exactly `targetBytes` total. */
function paddedPushBody(targetBytes: number): Buffer {
  const base = {
    installation: { id: 555 },
    repository: { id: 42, full_name: 'acme/widgets' },
    ref: 'refs/heads/main',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    forced: false,
    deleted: false,
    pusher: { name: 'octocat' },
    commits: [],
    padding: '',
  };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  const padding = 'x'.repeat(Math.max(0, targetBytes - overhead));
  return Buffer.from(JSON.stringify({ ...base, padding }));
}

let activeServer: Server | undefined;
let secretBackendCalls = 0;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  secretBackendCalls = 0;
  setSecretBackendForTests(async (ref) => {
    secretBackendCalls += 1;
    if (ref === 'env://GITHUB_WEBHOOK_SECRET') return SECRET;
    throw new Error(`unexpected secret ref in body-cap test: ${ref}`);
  });
  resolveInstallationOrg.mockClear();
  resolveInstallationOrg.mockResolvedValue({ orgId: 'org-resolved-1', active: true });
  publishIngestionEvent.mockClear();
  publishIngestionEvent.mockResolvedValue('sqs-message-id');
  enqueue.mockClear();
  enqueue.mockResolvedValue('bullmq-job-id');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  resetSecretsForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('GITHUB_WEBHOOK_MAX_BODY_BYTES (AC-6 / GAP-9)', () => {
  // @spec AC-6
  it('is exported from routes/githubWebhook.ts and stays at 5 MB', () => {
    expect(GITHUB_WEBHOOK_MAX_BODY_BYTES).toBe(EXPECTED_MAX_BODY_BYTES);
  });

  // The decision GAP-9 asked for has to be recorded where the limit lives, not only in
  // spec.md — this asserts the constant is what app.ts wires into express.raw() and that
  // the rationale comment exists next to it.
  // @spec AC-6
  it('is the value app.ts wires into the webhook express.raw() mount, with the rationale in code', () => {
    const appSource = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');

    expect(appSource).toContain('GITHUB_WEBHOOK_MAX_BODY_BYTES');
    expect(appSource).not.toMatch(/limit:\s*'5mb'/u);
    // Rationale: unauthenticated ingress, whole body buffered before the HMAC can run.
    expect(appSource.toLowerCase()).toMatch(/unauthenticated/u);
    expect(appSource).toMatch(/25\s?MB|25 ?mb/iu);
  });
});

describe('POST /webhooks/github — body cap enforcement (AC-6 / GAP-9)', () => {
  // @spec AC-6 EC-20
  it('accepts a valid body just under the cap and processes it normally', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const rawBody = paddedPushBody(EXPECTED_MAX_BODY_BYTES - 4096);
    expect(rawBody.byteLength).toBeLessThan(EXPECTED_MAX_BODY_BYTES);

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(rawBody),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-under-cap',
      },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    expect(publishIngestionEvent).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  }, 30_000);

  // @spec AC-6 EC-20
  it('rejects a body over the cap with 413 before the secret loader or any queue call runs', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const oversized = Buffer.alloc(EXPECTED_MAX_BODY_BYTES + 1, 'a');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(oversized),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-over-cap',
      },
      body: oversized,
    });

    expect(res.status).toBe(413);
    expect(secretBackendCalls).toBe(0);
    expect(publishIngestionEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  }, 30_000);

  // @spec AC-6 EC-21
  it('answers an over-cap request with exactly { error: "payload too large" } and one leak-free warning', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const marker = 'SUPERSECRETPAYLOADMARKER';
    const oversized = Buffer.from(
      marker + 'a'.repeat(EXPECTED_MAX_BODY_BYTES + 1 - marker.length),
    );
    const signature = sign(oversized);

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-over-cap-2',
      },
      body: oversized,
    });

    expect(res.status).toBe(413);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'payload too large' });
    expect(body).not.toContain(marker);

    // Exactly one warning, and nothing in it echoes header/body/signature/secret material.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('delivery-over-cap-2');
    expect(logged.length).toBeLessThan(200);
  }, 30_000);
});

// W3-04 gapfill (GAP-4). Leading-red coverage for the DEFAULT (non-injected)
// `publishOwnership` implementation: spec.md's Approach step 10 requires
//   enqueue('github-sync', envelope, { jobId: envelope.idempotency_key, ...GIT_SYNC_JOB_OPTIONS })
// The rest of githubWebhookService.test.ts always injects a fake `publishOwnership`, so
// the real default (the only place GIT_SYNC_JOB_OPTIONS is actually wired in) has no
// coverage today.
//
// Broker-free: mocks '../queue/bullmq''s enqueue() rather than hitting real Redis.

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../queue/envelope';

const enqueueMock = vi.hoisted(() => vi.fn(async () => 'job-id'));

vi.mock('../queue/bullmq', () => ({
  enqueue: enqueueMock,
}));

const SECRET = 'wh-secret';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function pushBody(): Buffer {
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
    }),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('githubWebhookService default publishOwnership (GAP-4)', () => {
  // @spec AC-7
  it('enqueues the github-sync job with GIT_SYNC_JOB_OPTIONS and the idempotency-derived jobId', async () => {
    const { handleGithubWebhook } = await import('./githubWebhookService');
    const { GIT_SYNC_JOB_OPTIONS } = await import('../integrations/git/jobPolicy');
    const rawBody = pushBody();

    await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'delivery-1' },
      {
        getWebhookSecret: async () => SECRET,
        resolveOrg: async () => ({ orgId: 'org-resolved-1', active: true }),
        publishIngestion: async () => undefined,
        // publishOwnership intentionally NOT overridden — exercises the real default.
      },
    );

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [queueName, envelope, opts] = enqueueMock.mock.calls[0] as [
      string,
      MessageEnvelope,
      Record<string, unknown>,
    ];
    expect(queueName).toBe('github-sync');
    expect(opts).toEqual(
      expect.objectContaining({
        jobId: envelope.idempotency_key,
        ...GIT_SYNC_JOB_OPTIONS,
      }),
    );
  });
});

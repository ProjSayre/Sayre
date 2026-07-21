import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  SecretNotFoundError,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import type { NormalizedRepoEvent } from '@sayre/shared-types';
import { makeEnvelope, type MessageEnvelope } from './envelope';
import {
  closeSqsClient,
  getSqsClient,
  ingestionGroupId,
  INGESTION_QUEUE,
  publish,
  publishIngestionEvent,
} from './sqs';

// This suite runs with the real @aws-sdk/client-sqs Command classes, but the
// client's `send` is always intercepted via a fake client factory (guarded by
// NODE_ENV==='test' inside getSqsClient) — no network/LocalStack access is required.

beforeEach(async () => {
  await closeSqsClient();
  setConfigOverrideForTests('AWS_REGION', 'us-east-1');
});

afterEach(async () => {
  await closeSqsClient();
  resetConfigForTests();
  resetSecretsForTests();
});

describe('ingestionGroupId', () => {
  it('matches the Python length-prefixed SHA-256 scheme byte-for-byte', () => {
    const orgId = 'org_1';
    const repoId = '42';
    const ref = 'refs/heads/main';

    const expected = createHash('sha256');
    for (const part of [orgId, repoId, ref]) {
      const encoded = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(encoded.length));
      expected.update(length);
      expected.update(encoded);
    }

    expect(ingestionGroupId(orgId, repoId, ref)).toBe(expected.digest('hex'));
  });

  it('is stable for the same org/repo/ref across calls', () => {
    const a = ingestionGroupId('org_1', '42', 'refs/heads/main');
    const b = ingestionGroupId('org_1', '42', 'refs/heads/main');
    expect(a).toBe(b);
  });

  it('differs when any component differs', () => {
    const base = ingestionGroupId('org_1', '42', 'refs/heads/main');
    expect(ingestionGroupId('org_2', '42', 'refs/heads/main')).not.toBe(base);
    expect(ingestionGroupId('org_1', '43', 'refs/heads/main')).not.toBe(base);
    expect(ingestionGroupId('org_1', '42', 'refs/heads/dev')).not.toBe(base);
  });

  it('rejects blank components', () => {
    expect(() => ingestionGroupId('', '42', 'refs/heads/main')).toThrow();
    expect(() => ingestionGroupId('org_1', '  ', 'refs/heads/main')).toThrow();
    expect(() => ingestionGroupId('org_1', '42', '')).toThrow();
  });
});

describe('getSqsClient', () => {
  it('rejects factory injection outside NODE_ENV=test', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(getSqsClient(() => ({}) as never)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('builds config from AWS_REGION and treats an unset SQS_ENDPOINT_URL as "use real AWS"', async () => {
    let received: Record<string, unknown> | undefined;
    const fake = { kind: 'fake' };
    await getSqsClient((cfg) => {
      received = cfg as unknown as Record<string, unknown>;
      return fake as never;
    });
    expect(received?.region).toBe('us-east-1');
    expect(received?.endpoint).toBeUndefined();
  });

  it('passes SQS_ENDPOINT_URL through when set (LocalStack)', async () => {
    setConfigOverrideForTests('SQS_ENDPOINT_URL', 'http://localhost:4566');
    let received: Record<string, unknown> | undefined;
    await getSqsClient((cfg) => {
      received = cfg as unknown as Record<string, unknown>;
      return {} as never;
    });
    expect(received?.endpoint).toBe('http://localhost:4566');
  });

  it('resolves AWS credentials via getSecret, never process.env directly', async () => {
    setSecretBackendForTests(async (ref) => {
      if (ref === 'env://AWS_ACCESS_KEY_ID') return 'AKIAFAKE';
      if (ref === 'env://AWS_SECRET_ACCESS_KEY') return 'fake-secret';
      throw new SecretNotFoundError(ref);
    });
    let received: Record<string, unknown> | undefined;
    await getSqsClient((cfg) => {
      received = cfg as unknown as Record<string, unknown>;
      return {} as never;
    });
    expect(received?.credentials).toMatchObject({
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'fake-secret',
    });
  });

  it('returns the same singleton on repeated calls', async () => {
    const fake = { kind: 'fake' };
    const first = await getSqsClient(() => fake as never);
    const second = await getSqsClient();
    expect(second).toBe(first);
  });
});

function buildEnvelope(overrides: Partial<NormalizedRepoEvent> = {}): MessageEnvelope<NormalizedRepoEvent> {
  return makeEnvelope<NormalizedRepoEvent>({
    org_id: 'org_1',
    type: 'repo.push',
    source: 'github-webhook',
    idempotency_key: 'delivery-1',
    payload: {
      provider: 'github',
      type: 'push',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: '999',
      delivery_id: 'delivery-1',
      payload: {},
      ...overrides,
    },
  });
}

describe('publish', () => {
  it('requires messageGroupId for a *.fifo queue', async () => {
    await getSqsClient(() => ({ send: vi.fn() }) as never);
    const envelope = buildEnvelope();
    await expect(publish('ingestion.fifo', envelope)).rejects.toThrow(/messageGroupId/);
  });

  it('rejects fifo options for a non-fifo queue', async () => {
    await getSqsClient(() => ({ send: vi.fn() }) as never);
    const envelope = buildEnvelope();
    await expect(
      publish('standard-queue', envelope, { messageGroupId: 'g' }),
    ).rejects.toThrow(/standard queue/);
  });

  it('sends MessageBody = JSON.stringify(envelope) and returns the SQS MessageId', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        return { QueueUrl: 'https://sqs.example/ingestion.fifo' };
      }
      return { MessageId: 'sqs-msg-1' };
    });
    await getSqsClient(() => ({ send }) as never);

    const envelope = buildEnvelope();
    const messageId = await publish('ingestion.fifo', envelope, {
      messageGroupId: 'group-1',
    });

    expect(messageId).toBe('sqs-msg-1');
    const sendCalls = send.mock.calls.map(([command]) => command as { input: Record<string, unknown> });
    const sendMessageCall = sendCalls.find((c) => 'MessageBody' in c.input);
    expect(sendMessageCall?.input.MessageBody).toBe(JSON.stringify(envelope));
    expect(sendMessageCall?.input.MessageGroupId).toBe('group-1');
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(envelope.idempotency_key);
  });

  it('defaults MessageDeduplicationId to envelope.idempotency_key when not supplied', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) return { QueueUrl: 'https://sqs.example/q.fifo' };
      return { MessageId: 'sqs-msg-2' };
    });
    await getSqsClient(() => ({ send }) as never);

    const envelope = buildEnvelope();
    await publish('q.fifo', envelope, { messageGroupId: 'g' });

    const sendMessageCall = send.mock.calls
      .map(([command]) => command as { input: Record<string, unknown> })
      .find((c) => 'MessageBody' in c.input);
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(envelope.idempotency_key);
  });

  it('caches the queue URL across repeated publishes to the same queue', async () => {
    let getQueueUrlCalls = 0;
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        getQueueUrlCalls += 1;
        return { QueueUrl: 'https://sqs.example/q.fifo' };
      }
      return { MessageId: `sqs-msg-${getQueueUrlCalls}` };
    });
    await getSqsClient(() => ({ send }) as never);

    await publish('q.fifo', buildEnvelope(), { messageGroupId: 'g' });
    await publish('q.fifo', buildEnvelope(), { messageGroupId: 'g' });

    expect(getQueueUrlCalls).toBe(1);
  });
});

describe('publishIngestionEvent', () => {
  it('publishes to INGESTION_QUEUE with MessageGroupId = ingestionGroupId(org_id, provider_repo_id, ref)', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        expect(command.input?.QueueName).toBe(INGESTION_QUEUE);
        return { QueueUrl: 'https://sqs.example/ingestion.fifo' };
      }
      return { MessageId: 'sqs-msg-ingestion' };
    });
    await getSqsClient(() => ({ send }) as never);

    const envelope = buildEnvelope();
    await publishIngestionEvent(envelope);

    const sendMessageCall = send.mock.calls
      .map(([command]) => command as { input: Record<string, unknown> })
      .find((c) => 'MessageBody' in c.input);
    expect(sendMessageCall?.input.MessageGroupId).toBe(
      ingestionGroupId('org_1', '42', 'refs/heads/main'),
    );
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(envelope.idempotency_key);
  });

  it('is stable across two deliveries for the same org/repo/ref', async () => {
    const groupIds: string[] = [];
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) return { QueueUrl: 'https://sqs.example/ingestion.fifo' };
      if (command.input?.MessageGroupId) groupIds.push(command.input.MessageGroupId as string);
      return { MessageId: 'sqs-msg' };
    });
    await getSqsClient(() => ({ send }) as never);

    await publishIngestionEvent(buildEnvelope());
    await publishIngestionEvent(buildEnvelope({ delivery_id: 'delivery-2' }));

    expect(groupIds).toHaveLength(2);
    expect(groupIds[0]).toBe(groupIds[1]);
  });

  it('throws when ref is null (cannot FIFO-group without a ref)', async () => {
    await getSqsClient(() => ({ send: vi.fn() }) as never);
    const envelope = buildEnvelope({ ref: null });
    await expect(publishIngestionEvent(envelope)).rejects.toThrow(/ref/);
  });
});

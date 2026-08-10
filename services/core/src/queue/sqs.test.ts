import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  SecretNotFoundError,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import type { NormalizedRepoEvent, RepoInitialParseEvent } from '@sayre/shared-types';
import { makeEnvelope, type MessageEnvelope } from './envelope';
import {
  closeSqsClient,
  getSqsClient,
  ingestionGroupId,
  INGESTION_QUEUE,
  messageDeduplicationId,
  publish,
  publishIngestionEvent,
  publishInitialParseEvent,
} from './sqs';
// CH-03 additions are reached through a namespace import so this file keeps
// loading (and the pre-existing cases above keep running) before `dev` adds the
// new exports — a missing named import would fail the whole module at load.
import * as sqsModule from './sqs';

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

describe('messageDeduplicationId', () => {
  it('returns a stable, fixed-width SHA-256 transport identifier', () => {
    const semanticKey = `github:initial_parse:999:42:refs/heads/${'feature/'.repeat(30)}:${'a'.repeat(40)}`;
    const expected = createHash('sha256').update(semanticKey, 'utf8').digest('hex');

    expect(messageDeduplicationId(semanticKey)).toBe(expected);
    expect(messageDeduplicationId(semanticKey)).toHaveLength(64);
  });

  it('rejects blank semantic keys', () => {
    expect(() => messageDeduplicationId('   ')).toThrow(/blank/);
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
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(
      messageDeduplicationId(envelope.idempotency_key),
    );
  });

  it('defaults MessageDeduplicationId to a hash of envelope.idempotency_key', async () => {
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
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(
      messageDeduplicationId(envelope.idempotency_key),
    );
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
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(
      messageDeduplicationId(envelope.idempotency_key),
    );
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

function buildInitialParseEnvelope(
  overrides: Partial<RepoInitialParseEvent> = {},
): MessageEnvelope<RepoInitialParseEvent> {
  const revisionSha = 'a'.repeat(40);
  return makeEnvelope<RepoInitialParseEvent>({
    org_id: 'org_1',
    type: 'repo.initial_parse',
    source: 'github-app-install',
    idempotency_key: `github:initial_parse:999:42:refs/heads/main:${revisionSha}`,
    payload: {
      provider: 'github',
      type: 'initial_parse',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      revision_sha: revisionSha,
      installation_id: '999',
      reason: 'app_install',
      ...overrides,
    },
  });
}

describe('publishInitialParseEvent', () => {
  it('publishes to INGESTION_QUEUE with MessageGroupId = ingestionGroupId(org_id, provider_repo_id, ref)', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        expect(command.input?.QueueName).toBe(INGESTION_QUEUE);
        return { QueueUrl: 'https://sqs.example/ingestion.fifo' };
      }
      return { MessageId: 'sqs-msg-initial-parse' };
    });
    await getSqsClient(() => ({ send }) as never);

    const envelope = buildInitialParseEnvelope();
    await publishInitialParseEvent(envelope);

    const sendMessageCall = send.mock.calls
      .map(([command]) => command as { input: Record<string, unknown> })
      .find((c) => 'MessageBody' in c.input);
    expect(sendMessageCall?.input.MessageGroupId).toBe(
      ingestionGroupId('org_1', '42', 'refs/heads/main'),
    );
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(
      messageDeduplicationId(envelope.idempotency_key),
    );
  });

  it('publishes a valid 64-character deduplication ID for a long GitHub branch', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        return { QueueUrl: 'https://sqs.example/ingestion.fifo' };
      }
      return { MessageId: 'sqs-msg-long-branch' };
    });
    await getSqsClient(() => ({ send }) as never);
    const branch = `refs/heads/${'feature/very-long-segment-'.repeat(8)}`;
    const envelope = buildInitialParseEnvelope({ ref: branch });
    envelope.idempotency_key =
      `github:initial_parse:999999999:424242424:${branch}:${'a'.repeat(40)}`;

    await publishInitialParseEvent(envelope);

    const sendMessageCall = send.mock.calls
      .map(([command]) => command as { input: Record<string, unknown> })
      .find((call) => 'MessageBody' in call.input);
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(
      messageDeduplicationId(envelope.idempotency_key),
    );
    expect(String(sendMessageCall?.input.MessageDeduplicationId)).toHaveLength(64);
  });

  it('is stable across two deliveries for the same org/repo/ref', async () => {
    const groupIds: string[] = [];
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) return { QueueUrl: 'https://sqs.example/ingestion.fifo' };
      if (command.input?.MessageGroupId) groupIds.push(command.input.MessageGroupId as string);
      return { MessageId: 'sqs-msg' };
    });
    await getSqsClient(() => ({ send }) as never);

    await publishInitialParseEvent(buildInitialParseEnvelope());
    await publishInitialParseEvent(
      buildInitialParseEnvelope({ installation_id: '1000' }),
    );

    expect(groupIds).toHaveLength(2);
    expect(groupIds[0]).toBe(groupIds[1]);
  });

  it('throws when ref is empty (cannot FIFO-group without a ref)', async () => {
    await getSqsClient(() => ({ send: vi.fn() }) as never);
    const envelope = buildInitialParseEnvelope({ ref: '' });
    await expect(publishInitialParseEvent(envelope)).rejects.toThrow(/ref/);
  });
});

// ---------------------------------------------------------------------------
// CH-03 — "Ask Sayre" chat-turns.fifo lane (authored by `red` from spec.md).
// ---------------------------------------------------------------------------

const CH03_CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const CH03_ASSISTANT_TURN_ID = '66666666-6666-4666-8666-666666666666';

function readRepoFile(relativePath: string): string {
  const url = new URL(`../../../../${relativePath}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

function buildChatTurnEnvelope(
  overrides: Record<string, unknown> = {},
): MessageEnvelope<Record<string, unknown>> {
  return makeEnvelope<Record<string, unknown>>({
    org_id: '11111111-1111-4111-8111-111111111111',
    type: 'chat.turn.request',
    source: 'sayre-core-chat',
    idempotency_key: `chat.turn:${CH03_ASSISTANT_TURN_ID}`,
    payload: {
      schema: 'chat.turn.request.v1',
      turnId: CH03_ASSISTANT_TURN_ID,
      conversationId: CH03_CONVERSATION_ID,
      orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      question: 'How does login work?',
      scope: { view: 'technical', anchorNodeId: 'file-42' },
      history: [{ role: 'user', content: 'earlier' }],
      mcpCredential: null,
      ...overrides,
    },
  });
}

describe('publishChatTurnRequest', () => {
  // @spec AC-8
  it('publishes to chat-turns.fifo grouped by conversation id and deduplicated by the turn key', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        expect(command.input?.QueueName).toBe('chat-turns.fifo');
        return { QueueUrl: 'https://sqs.example/chat-turns.fifo' };
      }
      return { MessageId: 'sqs-msg-chat' };
    });
    await getSqsClient(() => ({ send }) as never);

    const envelope = buildChatTurnEnvelope();
    const messageId = await sqsModule.publishChatTurnRequest(envelope as never);

    expect(messageId).toBe('sqs-msg-chat');
    const sendMessageCall = send.mock.calls
      .map(([command]) => command as { input: Record<string, unknown> })
      .find((call) => 'MessageBody' in call.input);
    expect(sendMessageCall?.input.MessageGroupId).toBe(CH03_CONVERSATION_ID);
    expect(sendMessageCall?.input.MessageDeduplicationId).toBe(
      messageDeduplicationId(`chat.turn:${CH03_ASSISTANT_TURN_ID}`),
    );
    expect(String(sendMessageCall?.input.MessageDeduplicationId)).toHaveLength(64);
  });

  // @spec AC-6
  it('serializes the pinned chat.turn.request.v1 payload with its key order intact', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        return { QueueUrl: 'https://sqs.example/chat-turns.fifo' };
      }
      return { MessageId: 'sqs-msg-chat-order' };
    });
    await getSqsClient(() => ({ send }) as never);

    const envelope = buildChatTurnEnvelope();
    await sqsModule.publishChatTurnRequest(envelope as never);

    const sendMessageCall = send.mock.calls
      .map(([command]) => command as { input: Record<string, unknown> })
      .find((call) => 'MessageBody' in call.input);
    const body = String(sendMessageCall?.input.MessageBody);
    expect(body).toBe(JSON.stringify(envelope));
    const parsed = JSON.parse(body) as { payload: Record<string, unknown> };
    expect(Object.keys(parsed.payload)).toEqual([
      'schema',
      'turnId',
      'conversationId',
      'orgId',
      'userId',
      'question',
      'scope',
      'history',
      'mcpCredential',
    ]);
    expect(parsed.payload.schema).toBe('chat.turn.request.v1');
    expect(parsed.payload.mcpCredential).toBeNull();
  });

  // @spec AC-8
  it('refuses to publish without a conversation id to group by', async () => {
    await getSqsClient(() => ({ send: vi.fn() }) as never);
    const envelope = buildChatTurnEnvelope({ conversationId: '   ' });
    await expect(sqsModule.publishChatTurnRequest(envelope as never)).rejects.toThrow(
      /conversationId/i,
    );
  });

  // @spec EC-21
  it('treats a send that returned no MessageId as a failure', async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown> }) => {
      if ('QueueName' in (command.input ?? {})) {
        return { QueueUrl: 'https://sqs.example/chat-turns.fifo' };
      }
      return {};
    });
    await getSqsClient(() => ({ send }) as never);

    await expect(
      sqsModule.publishChatTurnRequest(buildChatTurnEnvelope() as never),
    ).rejects.toThrow(/MessageId/u);
  });
});

describe('chat-turns lane declaration', () => {
  // @spec AC-9
  it('names one physical FIFO queue, distinct from every existing lane', () => {
    expect(sqsModule.CHAT_TURNS_QUEUE).toBe('chat-turns.fifo');
    expect(sqsModule.CHAT_TURNS_QUEUE.endsWith('.fifo')).toBe(true);
    expect([INGESTION_QUEUE, 'graph-updated-realtime', 'enrichment-default', 'embedding-upserts'])
      .not.toContain(sqsModule.CHAT_TURNS_QUEUE);
  });

  // @spec AC-9
  it('is provisioned by the LocalStack init hook with a FIFO DLQ, redrive and retention — and no SNS fan-out', () => {
    const hook = readRepoFile('infra/localstack/init/ready.d/01-create-sqs-queues.sh');
    expect(hook).toMatch(/create_fifo_queue chat-turns-dlq\.fifo/u);
    expect(hook).toMatch(/create_fifo_queue chat-turns\.fifo/u);
    // The DLQ joins the retention loop (14 days) and the source gets the shared
    // 5-receive redrive policy.
    expect(hook).toMatch(/"\$chat_turns_dlq_url"/u);
    expect(hook).toMatch(/configure_source "\$chat_turns_url" "\$\(queue_arn "\$chat_turns_dlq_url"\)"/u);
    expect(hook).toMatch(/RETENTION_SECONDS=1209600/u);
    expect(hook).toMatch(/MAX_RECEIVE_COUNT=5/u);
    // Deliberately never subscribed to the graph-updated topic.
    expect(hook).not.toMatch(/allow_topic "\$chat_turns_url"/u);
    expect(hook).not.toMatch(/ensure_raw_subscription "\$chat_turns_url"/u);
  });

  // @spec AC-9
  it('is declared to the Python fleet as a production queue that requires a durable delivery store', () => {
    const client = readRepoFile('services/workers/messaging/sqs_client.py');
    expect(client).toMatch(/CHAT_TURNS_QUEUE = "chat-turns\.fifo"/u);
    const productionQueues = /_PRODUCTION_QUEUES = frozenset\(\s*\{([\s\S]*?)\}\s*\)/u.exec(client);
    expect(productionQueues?.[1] ?? '').toContain('CHAT_TURNS_QUEUE');

    const envExample = readRepoFile('infra/.env.example');
    expect(envExample).toMatch(/SQS_CHAT_TURNS_QUEUE=chat-turns\.fifo/u);
  });

  // @spec AC-10
  it('is recorded in the approved messaging topology contract', () => {
    const contracts = readRepoFile('docs/wave0-foundation-contracts.md');
    const afterHeading = contracts.split('## Ingestion, events, and background work')[1] ?? '';
    const section = afterHeading.split(/\n## /u)[0] ?? '';
    // The whole bullet (a `- ` item that may wrap over several lines).
    const bullet =
      (section.split(/\n- /u).find((item) => item.includes('chat-turns.fifo')) ?? '')
        .replace(/\s+/gu, ' ');

    expect(bullet).toContain('chat-turns.fifo');
    expect(bullet).toContain('chat-turns-dlq.fifo');
    expect(bullet).toMatch(/FIFO/u);
    expect(bullet).toMatch(/message-group|message group/u);
    expect(bullet).toMatch(/conversation id/u);
    expect(bullet).toMatch(/idempoten/u);
    expect(bullet).toMatch(/never subscribed|not subscribed/u);
  });
});

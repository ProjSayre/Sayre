import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { createRealtimeSqsConsumer } from './consumer';

function validEnvelopeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message_id: 'm1',
    idempotency_key: 'm1',
    org_id: 'org-a',
    type: 'graph.updated',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    source: 'ingestion-worker',
    graph_scope_key: 'repo-1:main',
    graph_version: 1,
    payload: {
      repository_id: 'repo-1',
      ref_name: 'refs/heads/main',
      revision_sha: 'abc',
      full_rebuild: false,
      changed_paths: [],
      structural_duration_ms: 100,
    },
    ...overrides,
  });
}

/** A fake SQSClient that serves one queued batch per ReceiveMessageCommand call
 * (then empties out), and records DeleteMessageCommand calls. Once the queued
 * batches are exhausted, ReceiveMessageCommand sleeps briefly before resolving
 * empty — mimicking a real long-poll wait so the consumer's `while (!stopped)`
 * loop can't spin unbounded (and exhaust the test process's heap) while
 * `consumer.stop()` is still in flight. */
function fakeClient(batches: Message[][]) {
  const deletions: string[] = [];
  let call = 0;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetQueueUrlCommand) {
      return { QueueUrl: 'http://localstack/queue/graph-updated-realtime' };
    }
    if (command instanceof ReceiveMessageCommand) {
      if (call >= batches.length) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { Messages: [] };
      }
      const batch = batches[call];
      call += 1;
      return { Messages: batch };
    }
    if (command instanceof DeleteMessageCommand) {
      deletions.push((command as DeleteMessageCommand).input.ReceiptHandle as string);
      return {};
    }
    throw new Error('unexpected command');
  });
  return { send, deletions } as unknown as { send: typeof send; deletions: string[] };
}

describe('createRealtimeSqsConsumer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC7: deletes exactly once after a successful onEnvelope', async () => {
    const client = fakeClient([
      [{ MessageId: '1', ReceiptHandle: 'rh-1', Body: validEnvelopeBody() }],
      [],
    ]);
    const onEnvelope = vi.fn(async () => undefined);
    const consumer = createRealtimeSqsConsumer({
      queueName: 'graph-updated-realtime',
      onEnvelope,
      waitTimeSeconds: 0,
      clientFactory: () => client as never,
    });

    consumer.start();
    await vi.waitFor(() => expect(onEnvelope).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.deletions).toEqual(['rh-1']));
    await consumer.stop();
  });

  it('AC7: a malformed (non-JSON) body is never deleted, left for redrive', async () => {
    const client = fakeClient([[{ MessageId: '1', ReceiptHandle: 'rh-bad', Body: 'not json' }], []]);
    const onEnvelope = vi.fn(async () => undefined);
    const consumer = createRealtimeSqsConsumer({
      queueName: 'graph-updated-realtime',
      onEnvelope,
      waitTimeSeconds: 0,
      clientFactory: () => client as never,
    });

    consumer.start();
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    await consumer.stop();

    expect(onEnvelope).not.toHaveBeenCalled();
    expect(client.deletions).toEqual([]);
  });

  it('AC7: a schema-invalid envelope (missing required field) is never deleted', async () => {
    const badBody = JSON.stringify({ type: 'graph.updated', payload: {} }); // missing org_id etc.
    const client = fakeClient([[{ MessageId: '1', ReceiptHandle: 'rh-invalid', Body: badBody }], []]);
    const onEnvelope = vi.fn(async () => undefined);
    const consumer = createRealtimeSqsConsumer({
      queueName: 'graph-updated-realtime',
      onEnvelope,
      waitTimeSeconds: 0,
      clientFactory: () => client as never,
    });

    consumer.start();
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    await consumer.stop();

    expect(onEnvelope).not.toHaveBeenCalled();
    expect(client.deletions).toEqual([]);
  });

  it('rejects an envelope whose type is not graph.updated, without deleting', async () => {
    const wrongType = validEnvelopeBody({ type: 'graph.other' });
    const client = fakeClient([[{ MessageId: '1', ReceiptHandle: 'rh-wrong-type', Body: wrongType }], []]);
    const onEnvelope = vi.fn(async () => undefined);
    const consumer = createRealtimeSqsConsumer({
      queueName: 'graph-updated-realtime',
      onEnvelope,
      waitTimeSeconds: 0,
      clientFactory: () => client as never,
    });

    consumer.start();
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    await consumer.stop();

    expect(onEnvelope).not.toHaveBeenCalled();
    expect(client.deletions).toEqual([]);
  });

  it('AC7 / Redis-down edge case: when onEnvelope throws, the message is left undeleted for redelivery', async () => {
    const client = fakeClient([
      [{ MessageId: '1', ReceiptHandle: 'rh-fail', Body: validEnvelopeBody() }],
      [],
    ]);
    const onEnvelope = vi.fn(async () => {
      throw new Error('redis publish failed');
    });
    const consumer = createRealtimeSqsConsumer({
      queueName: 'graph-updated-realtime',
      onEnvelope,
      waitTimeSeconds: 0,
      clientFactory: () => client as never,
    });

    consumer.start();
    await vi.waitFor(() => expect(onEnvelope).toHaveBeenCalledTimes(1));
    await consumer.stop();

    expect(client.deletions).toEqual([]);
  });

  it('start() is idempotent; stop() halts the poll loop', async () => {
    const client = fakeClient([[], [], []]);
    const onEnvelope = vi.fn(async () => undefined);
    const consumer = createRealtimeSqsConsumer({
      queueName: 'graph-updated-realtime',
      onEnvelope,
      waitTimeSeconds: 0,
      clientFactory: () => client as never,
    });

    consumer.start();
    consumer.start(); // idempotent -- does not spawn a second loop
    await consumer.stop();
    const callsAfterStop = client.send.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.send.mock.calls.length).toBe(callsAfterStop); // no further polling after stop()
  });
});

// W0-04 (GAP-4a) — thin, test-only harness driven by
// services/workers/tests/test_cross_runtime_roundtrip.py. No business logic: it starts
// the REAL createRealtimeSqsConsumer (services/gateway/src/sqs/consumer.ts) against
// whatever broker @sayre/config resolves, and waits for exactly one envelope whose
// idempotency_key matches --match-idempotency-key.
//
// A non-matching envelope is deliberately left in-flight (its onEnvelope callback
// never resolves) rather than treated as "handled" — this harness only speaks for the
// one marker message a test published, and consumer.ts only deletes a message after
// onEnvelope resolves successfully (see consumer.ts's queue-semantics header comment).
// EC-17 needs exactly that: a message this harness never finished with must stay on
// the queue (undeleted) for redelivery if the harness is killed, not be silently
// acknowledged.
//
// Usage: npx tsx test/cross-runtime/consumeRealtime.ts --queue graph-updated-realtime \
//          --match-idempotency-key <key> --timeout-ms 30000
// Stdout (single line): the received envelope as JSON.
// Exit 0 on match; non-zero on timeout or validation failure, reason on stderr.

import type { MessageEnvelope } from '@sayre/core';
import type { GraphUpdatedPayload } from '@sayre/shared-types';
import { createRealtimeSqsConsumer } from '../../src/sqs/consumer';

interface CliOptions {
  queue: string;
  matchIdempotencyKey: string;
  timeoutMs: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: Partial<CliOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--queue' && value !== undefined) {
      options.queue = value;
      index += 1;
    } else if (flag === '--match-idempotency-key' && value !== undefined) {
      options.matchIdempotencyKey = value;
      index += 1;
    } else if (flag === '--timeout-ms' && value !== undefined) {
      options.timeoutMs = Number(value);
      index += 1;
    } else {
      throw new Error(
        'Usage: consumeRealtime.ts --queue <name> --match-idempotency-key <key> --timeout-ms <ms>',
      );
    }
  }
  if (
    !options.queue ||
    !options.matchIdempotencyKey ||
    options.timeoutMs === undefined ||
    !Number.isFinite(options.timeoutMs)
  ) {
    throw new Error(
      'Usage: consumeRealtime.ts --queue <name> --match-idempotency-key <key> --timeout-ms <ms>',
    );
  }
  return options as CliOptions;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let resolveMatch!: (envelope: MessageEnvelope<GraphUpdatedPayload>) => void;
  const matched = new Promise<MessageEnvelope<GraphUpdatedPayload>>((resolve) => {
    resolveMatch = resolve;
  });

  const consumer = createRealtimeSqsConsumer({
    queueName: options.queue,
    onEnvelope: async (envelope) => {
      if (envelope.idempotency_key === options.matchIdempotencyKey) {
        resolveMatch(envelope);
        return;
      }
      // Not the message this run is waiting for: never resolve, so the real
      // consumer never deletes it (EC-17 — left in-flight for redelivery).
      await new Promise<void>(() => {});
    },
  });

  consumer.start();

  const timedOut = Symbol('timeout');
  const timeout = new Promise<typeof timedOut>((resolve) => {
    setTimeout(() => resolve(timedOut), options.timeoutMs);
  });

  const outcome = await Promise.race([matched, timeout]);
  await consumer.stop().catch(() => undefined);

  if (outcome === timedOut) {
    process.stderr.write(
      `Timed out after ${options.timeoutMs}ms waiting for idempotency_key=` +
        `${options.matchIdempotencyKey} on queue "${options.queue}".\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

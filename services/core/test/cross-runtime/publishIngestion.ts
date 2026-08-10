// W0-04 (GAP-4) — thin, test-only harness driven by
// services/workers/tests/test_cross_runtime_roundtrip.py. No business logic: it reads a
// fully formed MessageEnvelope<RepoInitialParseEvent> as JSON on stdin and calls the
// REAL services/core/src/queue/sqs.ts `publishInitialParseEvent` against whatever
// broker @sayre/config resolves — the exact production path, not a parallel
// implementation of it.
//
// EC-16 guard: @sayre/config gives AWS_REGION a default (us-east-1) but deliberately
// gives SQS_ENDPOINT_URL none — unset means "use real AWS" to production code
// (services/core/src/queue/sqs.ts's resolveEndpointUrl). A cross-runtime TEST harness
// must never silently target real AWS because an env var was forgotten, so this
// refuses to run at all when SQS_ENDPOINT_URL is unset, rather than falling through to
// publishInitialParseEvent's own (production-correct) real-AWS fallback.
//
// Usage: npx tsx test/cross-runtime/publishIngestion.ts   (envelope JSON on stdin)
// Stdout (single line): {"messageId": "<sqs message id>"}
// Exit 0 on publish; non-zero with the error on stderr otherwise.

import { ConfigError, getConfig } from '@sayre/config';
import type { RepoInitialParseEvent } from '@sayre/shared-types';
import { assertValidEnvelope, type MessageEnvelope } from '../../src/queue/envelope';
import { publishInitialParseEvent } from '../../src/queue/sqs';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  // EC-16: refuse before touching stdin/the network at all when the broker endpoint
  // was not explicitly provisioned for this run.
  try {
    getConfig('SQS_ENDPOINT_URL');
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new Error(
        'SQS_ENDPOINT_URL is not set — refusing to publish (would otherwise silently ' +
          'target real AWS). Set SQS_ENDPOINT_URL to the LocalStack endpoint for this run.',
      );
    }
    throw error;
  }

  const raw = await readStdin();
  const parsed: unknown = JSON.parse(raw);
  // Producer-side guard (EC-11): a blank/missing org_id (or any other malformed
  // envelope field) is refused here, before publish, rather than defaulted.
  assertValidEnvelope(parsed);
  const envelope = parsed as MessageEnvelope<RepoInitialParseEvent>;

  const messageId = await publishInitialParseEvent(envelope);
  process.stdout.write(`${JSON.stringify({ messageId })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

// W1-02 gapfill (GAP-4 / AC-1): dedup identity for a GitHub webhook delivery, derived
// ONLY from the raw bytes X-Hub-Signature-256 covers.
//
// X-GitHub-Delivery is NOT covered by the HMAC signature — anyone who captures a
// genuine (body, signature) pair can freely mint a fresh delivery id and replay it as
// if it were a new event. Deriving the SQS MessageDeduplicationId / BullMQ jobId from
// that header therefore let a captured, still-validly-signed delivery be replayed as
// "new" work. Hashing the signed bytes themselves closes that gap: identical bytes
// always produce the identical dedup identity, regardless of which delivery id rides
// along with them. The delivery id remains useful and is kept — as trace_id /
// payload.delivery_id — for attribution only, never for anything security-relevant.

import { createHash } from 'node:crypto';

export const GITHUB_WEBHOOK_IDEMPOTENCY_PREFIX = 'github:webhook:';

/**
 * Dedup identity for a GitHub delivery, derived ONLY from the bytes covered by
 * X-Hub-Signature-256. Never mixes in X-GitHub-Delivery or any other unsigned header:
 * an attacker who captures a valid (body, signature) pair must not be able to mint a
 * fresh dedup identity by editing a header. Returns
 * `github:webhook:<sha256(rawBody) hex>`.
 */
export function githubWebhookIdempotencyKey(rawBody: Buffer): string {
  return `${GITHUB_WEBHOOK_IDEMPOTENCY_PREFIX}${createHash('sha256').update(rawBody).digest('hex')}`;
}

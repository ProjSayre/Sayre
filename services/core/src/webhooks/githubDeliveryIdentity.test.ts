// Red-stage (W1-02 gapfill, GAP-4 / AC-1) unit coverage for the signed-body-derived
// webhook dedup identity.
//
// The whole point of AC-1 is that the dedup identity is a function of ONLY the bytes
// X-Hub-Signature-256 covers. These tests therefore recompute the expected digest here
// with node:crypto rather than reusing anything the implementation exports beyond the
// function under test, so a wrong-but-self-consistent implementation cannot pass.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_WEBHOOK_IDEMPOTENCY_PREFIX,
  githubWebhookIdempotencyKey,
} from './githubDeliveryIdentity';

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

describe('githubWebhookIdempotencyKey (AC-1 / GAP-4)', () => {
  // @spec AC-1
  it('exports the fixed `github:webhook:` prefix', () => {
    expect(GITHUB_WEBHOOK_IDEMPOTENCY_PREFIX).toBe('github:webhook:');
  });

  // @spec AC-1
  it('returns `github:webhook:<sha256 hex of the raw signed body>`', () => {
    const rawBody = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'b'.repeat(40) }));

    expect(githubWebhookIdempotencyKey(rawBody)).toBe(
      `github:webhook:${sha256Hex(rawBody)}`,
    );
  });

  // @spec AC-1
  it('emits a 64-character lowercase hex digest after the prefix', () => {
    const key = githubWebhookIdempotencyKey(Buffer.from('{"a":1}'));

    expect(key.startsWith(GITHUB_WEBHOOK_IDEMPOTENCY_PREFIX)).toBe(true);
    expect(key.slice(GITHUB_WEBHOOK_IDEMPOTENCY_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/u);
  });

  // The signature covers the bytes and nothing else. A one-parameter function is the
  // structural guarantee that no unsigned header (X-GitHub-Delivery above all) can be
  // mixed into the identity — an implementation that accepted a delivery id would have
  // to change this arity.
  // @spec AC-1
  it('takes the raw body as its only input — no header can be mixed in', () => {
    expect(githubWebhookIdempotencyKey.length).toBe(1);
  });

  // @spec AC-1 EC-2
  it('is a pure function of the bytes: identical bytes always yield an identical key', () => {
    const a = Buffer.from(JSON.stringify({ installation: { id: 555 }, ref: 'refs/heads/main' }));
    const b = Buffer.from(JSON.stringify({ installation: { id: 555 }, ref: 'refs/heads/main' }));

    expect(a.equals(b)).toBe(true);
    expect(githubWebhookIdempotencyKey(a)).toBe(githubWebhookIdempotencyKey(b));
  });

  // @spec EC-3
  it('yields different keys for different bytes (no accidental collapse of two real events)', () => {
    const first = Buffer.from(JSON.stringify({ after: 'a'.repeat(40) }));
    const second = Buffer.from(JSON.stringify({ after: 'b'.repeat(40) }));

    expect(githubWebhookIdempotencyKey(first)).not.toBe(githubWebhookIdempotencyKey(second));
  });

  // @spec EC-3
  it('yields different keys for bodies differing by a single byte', () => {
    const first = Buffer.from('{"n":1}');
    const second = Buffer.from('{"n":2}');

    expect(githubWebhookIdempotencyKey(first)).not.toBe(githubWebhookIdempotencyKey(second));
  });

  // @spec AC-1
  it('handles an empty body deterministically rather than throwing', () => {
    const empty = Buffer.alloc(0);

    expect(githubWebhookIdempotencyKey(empty)).toBe(`github:webhook:${sha256Hex(empty)}`);
    expect(githubWebhookIdempotencyKey(empty)).toBe(githubWebhookIdempotencyKey(Buffer.alloc(0)));
  });

  // @spec AC-1
  it('hashes bytes, not a lossy string decode — two distinct non-UTF8 byte strings differ', () => {
    const first = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const second = Buffer.from([0xff, 0xfd, 0x00, 0x01]);

    expect(githubWebhookIdempotencyKey(first)).toBe(`github:webhook:${sha256Hex(first)}`);
    expect(githubWebhookIdempotencyKey(first)).not.toBe(githubWebhookIdempotencyKey(second));
  });
});

// Pure HMAC verification for GitHub's `X-Hub-Signature-256` webhook header.
//
// Deliberately takes `secret` as a plain argument rather than resolving it — the
// caller (the service layer, per .claude/rules/service-layer.md) is responsible for
// obtaining it exclusively through the W0-07 loader (`getSecret('env://GITHUB_WEBHOOK_SECRET')`)
// and never logging it. This module never touches getSecret/getConfig/process.env.

import { createHmac, timingSafeEqual } from 'node:crypto';

export class WebhookSignatureError extends Error {
  constructor(message = 'GitHub webhook signature verification failed.') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;

/**
 * Constant-time verification of GitHub's X-Hub-Signature-256 header.
 * `header` is the raw "sha256=<hex>" value. Returns true iff it matches
 * HMAC-SHA256(secret, rawBody). Uses crypto.timingSafeEqual on equal-length buffers;
 * a missing/malformed/wrong-length/non-hex header returns false (never throws on shape).
 *
 * Only the `-256` scheme is accepted — a legacy `X-Hub-Signature` (sha1) header is
 * never read by this function or its caller.
 */
export function verifyGithubSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (typeof header !== 'string' || !SIGNATURE_RE.test(header)) {
    return false;
  }

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  const headerBuffer = Buffer.from(header, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (headerBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(headerBuffer, expectedBuffer);
}

// Test-only loader for the captured GitHub webhook delivery fixtures in this
// directory. NOT imported by any receiver code (services/githubWebhookService.ts,
// routes/githubWebhook.ts, webhooks/normalizeGithubEvent.ts, webhooks/githubSignature.ts)
// — the fixtures are Tester's, not the implementation's, per spec.md.
//
// Each fixture file is `{ headers: Record<string,string>, body: unknown }`. The "raw
// body bytes GitHub signed" are reconstructed deterministically as
// `Buffer.from(JSON.stringify(body))` — a fixed byte sequence we compute the
// X-Hub-Signature-256 HMAC over at replay time (in the fixture's own webhook secret),
// exactly mirroring how the real route reads `express.raw()` bytes before any JSON
// parsing happens.

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';

export interface WebhookFixture {
  headers: Record<string, string>;
  rawBody: Buffer;
  body: unknown;
}

export function loadFixture(name: string): WebhookFixture {
  const filePath = join(__dirname, name);
  const contents = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(contents) as { headers: Record<string, string>; body: unknown };
  const rawBody = Buffer.from(JSON.stringify(parsed.body));
  return { headers: parsed.headers, rawBody, body: parsed.body };
}

/** Signs `rawBody` the way GitHub does, for replaying a fixture with a known test secret. */
export function signFixture(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

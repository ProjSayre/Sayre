import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubSignature, WebhookSignatureError } from './githubSignature';

const SECRET = 'test-webhook-secret';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(verifyGithubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a missing header', () => {
    const body = Buffer.from('{}');
    expect(verifyGithubSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const body = Buffer.from('{}');
    const digest = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyGithubSignature(body, digest, SECRET)).toBe(false);
  });

  it('rejects a header of the wrong length', () => {
    const body = Buffer.from('{}');
    expect(verifyGithubSignature(body, 'sha256=deadbeef', SECRET)).toBe(false);
  });

  it('rejects a non-hex header of the right length', () => {
    const body = Buffer.from('{}');
    const notHex = 'z'.repeat(64);
    expect(verifyGithubSignature(body, `sha256=${notHex}`, SECRET)).toBe(false);
  });

  it('rejects a correct-algorithm, wrong-digest header (equal length, tampered body)', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const tampered = Buffer.from(JSON.stringify({ hello: 'World' })); // 1-char diff, same length
    expect(verifyGithubSignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it('rejects when only a legacy sha1 X-Hub-Signature-shaped value is supplied', () => {
    const body = Buffer.from('{}');
    // sha1 hex digests are 40 chars — doesn't match the sha256=<64 hex> shape at all.
    expect(verifyGithubSignature(body, 'sha1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', SECRET)).toBe(
      false,
    );
  });

  it('rejects when the raw bytes differ from what was signed, even if re-serialized JSON looks equal', () => {
    const original = Buffer.from('{"a":1,"b":2}');
    const reordered = Buffer.from('{"b":2,"a":1}'); // same JSON meaning, different bytes
    expect(verifyGithubSignature(reordered, sign(original), SECRET)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const body = Buffer.from('{}');
    expect(verifyGithubSignature(body, sign(body, SECRET), 'a-different-secret')).toBe(false);
  });

  it('never throws on a malformed header — returns false instead', () => {
    const body = Buffer.from('{}');
    expect(() => verifyGithubSignature(body, 'not-even-close', SECRET)).not.toThrow();
    expect(verifyGithubSignature(body, 'not-even-close', SECRET)).toBe(false);
  });
});

describe('WebhookSignatureError', () => {
  it('is a distinguishable Error subclass', () => {
    const err = new WebhookSignatureError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WebhookSignatureError');
  });
});

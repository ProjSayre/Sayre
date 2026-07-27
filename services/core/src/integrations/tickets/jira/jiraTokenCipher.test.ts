// Unit tests for the AES-256-GCM Jira token cipher: round-trip, tamper
// detection (auth-tag mismatch never returns wrong plaintext), missing/short
// key fails closed, and no plaintext/key ever appears in a thrown message.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import { decryptToken, encryptToken, JiraTokenCipherError } from './jiraTokenCipher';

// 32 raw bytes, base64-encoded (matches the documented key shape).
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');
const PLAINTEXT = 'jira-super-secret-access-token-value';

function withKey(key: string | undefined): void {
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JIRA_TOKEN_ENC_KEY') {
      if (key === undefined) throw new Error('secret not configured');
      return key;
    }
    throw new Error(`unexpected secret ref: ${ref}`);
  });
}

afterEach(() => {
  resetSecretsForTests();
});

describe('encryptToken / decryptToken', () => {
  beforeEach(() => {
    withKey(VALID_KEY);
  });

  it('round-trips a token through encrypt -> decrypt', async () => {
    const stored = await encryptToken(PLAINTEXT);
    expect(await decryptToken(stored)).toBe(PLAINTEXT);
  });

  it('round-trips a second, distinct token independently (refresh token column)', async () => {
    const other = 'a-completely-different-refresh-token';
    const stored = await encryptToken(other);
    expect(await decryptToken(stored)).toBe(other);
  });

  it('prefixes ciphertext with the "v1:" version tag, colon-joined with iv/tag/ct', async () => {
    const stored = await encryptToken(PLAINTEXT);
    const parts = stored.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('produces a different ciphertext (and IV) each time for the same plaintext', async () => {
    const a = await encryptToken(PLAINTEXT);
    const b = await encryptToken(PLAINTEXT);
    expect(a).not.toBe(b);
    const ivA = a.split(':')[1];
    const ivB = b.split(':')[1];
    expect(ivA).not.toBe(ivB);
  });

  it('never contains the plaintext substring in the ciphertext envelope', async () => {
    const stored = await encryptToken(PLAINTEXT);
    expect(stored).not.toContain(PLAINTEXT);
  });

  describe('tamper detection', () => {
    it('throws (never returns wrong plaintext) when the ciphertext body is flipped', async () => {
      const stored = await encryptToken(PLAINTEXT);
      const [version, iv, tag, ct] = stored.split(':');
      const ctBuf = Buffer.from(ct, 'base64');
      ctBuf[0] = ctBuf[0] ^ 0xff; // flip a byte
      const tampered = [version, iv, tag, ctBuf.toString('base64')].join(':');
      await expect(decryptToken(tampered)).rejects.toBeInstanceOf(JiraTokenCipherError);
    });

    it('throws when the auth tag is flipped (classic GCM tamper)', async () => {
      const stored = await encryptToken(PLAINTEXT);
      const [version, iv, tag, ct] = stored.split(':');
      const tagBuf = Buffer.from(tag, 'base64');
      tagBuf[0] = tagBuf[0] ^ 0xff;
      const tampered = [version, iv, tagBuf.toString('base64'), ct].join(':');
      await expect(decryptToken(tampered)).rejects.toBeInstanceOf(JiraTokenCipherError);
    });

    it('throws when the IV is flipped', async () => {
      const stored = await encryptToken(PLAINTEXT);
      const [version, iv, tag, ct] = stored.split(':');
      const ivBuf = Buffer.from(iv, 'base64');
      ivBuf[0] = ivBuf[0] ^ 0xff;
      const tampered = [version, ivBuf.toString('base64'), tag, ct].join(':');
      await expect(decryptToken(tampered)).rejects.toBeInstanceOf(JiraTokenCipherError);
    });

    it('throws on an unrecognized version prefix (future-proofing / downgrade attempts)', async () => {
      const stored = await encryptToken(PLAINTEXT);
      const [, iv, tag, ct] = stored.split(':');
      await expect(decryptToken(['v2', iv, tag, ct].join(':'))).rejects.toBeInstanceOf(
        JiraTokenCipherError,
      );
    });

    it('throws on a malformed (wrong part count) stored value', async () => {
      await expect(decryptToken('v1:only:three')).rejects.toBeInstanceOf(JiraTokenCipherError);
      await expect(decryptToken('not-encrypted-at-all')).rejects.toBeInstanceOf(
        JiraTokenCipherError,
      );
    });

    it('never leaks the plaintext or key in the thrown error message on tamper', async () => {
      const stored = await encryptToken(PLAINTEXT);
      const [version, iv, tag, ct] = stored.split(':');
      const ctBuf = Buffer.from(ct, 'base64');
      ctBuf[0] = ctBuf[0] ^ 0xff;
      const tampered = [version, iv, tag, ctBuf.toString('base64')].join(':');
      try {
        await decryptToken(tampered);
        throw new Error('expected decryptToken to reject');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(PLAINTEXT);
        expect(message).not.toContain(VALID_KEY);
      }
    });
  });

  describe('key failure modes (fail closed)', () => {
    it('throws when JIRA_TOKEN_ENC_KEY is unavailable (missing) at first encrypt', async () => {
      withKey(undefined);
      await expect(encryptToken(PLAINTEXT)).rejects.toThrow();
    });

    it('throws (fail closed) when the key is empty rather than silently using a zero-length key', async () => {
      // The W0-07 getSecret loader itself rejects an empty-string secret
      // value with EmptySecretError before jiraTokenCipher's own key-length
      // check ever runs — still fail-closed (never a silent zero-length
      // key), just one layer up. See packages/config/src/secrets.ts.
      withKey('');
      await expect(encryptToken(PLAINTEXT)).rejects.toThrow();
    });

    it('throws when the key decodes to the wrong byte length (not 32 bytes)', async () => {
      withKey(Buffer.alloc(16, 1).toString('base64')); // AES-128-length key, wrong for AES-256-GCM
      await expect(encryptToken(PLAINTEXT)).rejects.toBeInstanceOf(JiraTokenCipherError);
    });

    it('never echoes the key material in a key-failure error message', async () => {
      const badKey = Buffer.alloc(16, 1).toString('base64');
      withKey(badKey);
      try {
        await encryptToken(PLAINTEXT);
        throw new Error('expected encryptToken to reject');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(badKey);
      }
    });
  });
});

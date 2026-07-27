// Application-level AES-256-GCM encryption of the per-org Jira OAuth tokens at
// rest (W3-10 OQ-2 — recommended default, human-confirmed). This is the first
// raw, long-lived credential the platform persists in Postgres (GitHub stores
// only IDs; MCP stores only an HMAC digest of a secret it never holds) — a DB
// dump alone must not yield a usable Jira token.
//
// Key = `getSecret('env://JIRA_TOKEN_ENC_KEY')` (base64, decoded to 32 bytes),
// resolved through the SAME W0-07 loader every other secret goes through.
// PM-07 later swaps the key source for KMS without changing this module's
// call sites (`db/jiraConnectionStore.ts` is the only caller).
//
// Deviation from spec.md's literal (synchronous) `encryptToken`/`decryptToken`
// signatures: both are async here because the encryption key itself is
// resolved through the asynchronous `getSecret` loader (every secret loader in
// this codebase is async — see packages/config/src/secrets.ts) — a truly
// synchronous signature would require a separate, undocumented synchronous
// key-caching mechanism. Noted in .pipeline/changes.md "Deviations from spec".
//
// Never logs plaintext, ciphertext, or key material. A tampered ciphertext
// (auth-tag mismatch) always throws — it never returns a wrong plaintext.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getSecret } from '@sayre/config';

const ALGORITHM = 'aes-256-gcm';
// Version prefix so a later PM-07 migration can distinguish ciphertext
// generations (e.g. re-encrypting under a KMS-managed data key).
const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit GCM IV, the NIST-recommended size for GCM.
const KEY_BYTES = 32; // AES-256

export class JiraTokenCipherError extends Error {
  constructor(message = 'Jira token ciphertext could not be processed.') {
    super(message);
    this.name = 'JiraTokenCipherError';
  }
}

async function loadKey(): Promise<Buffer> {
  const encoded = await getSecret('env://JIRA_TOKEN_ENC_KEY');
  let key: Buffer;
  try {
    key = Buffer.from(encoded, 'base64');
  } catch {
    throw new JiraTokenCipherError();
  }
  // A malformed/short/empty key must fail closed at first use, never silently
  // encrypt/decrypt with a truncated or zero-length key.
  if (key.length !== KEY_BYTES) {
    throw new JiraTokenCipherError();
  }
  return key;
}

/** Encrypts `plaintext`, returning "v1:<ivB64>:<tagB64>:<ctB64>". */
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Decrypts a value produced by `encryptToken`. Throws on any tamper/format failure. */
export async function decryptToken(stored: string): Promise<string> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new JiraTokenCipherError();
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivB64, 'base64');
    tag = Buffer.from(tagB64, 'base64');
    ciphertext = Buffer.from(ciphertextB64, 'base64');
  } catch {
    throw new JiraTokenCipherError();
  }
  if (iv.length !== IV_BYTES || tag.length === 0 || ciphertext.length === 0) {
    throw new JiraTokenCipherError();
  }

  const key = await loadKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // GCM auth-tag mismatch (tamper) and any other decrypt failure are
    // indistinguishable here on purpose — never leak which check failed.
    throw new JiraTokenCipherError();
  }
}

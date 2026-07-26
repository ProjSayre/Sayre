// Unit tests for the signed login-state token: round-trip, expiry, tamper,
// wrong-purpose rejection, cross-family rejection, and redirect_to
// validation. Mirrors src/github/installState.test.ts. Uses the real
// `jsonwebtoken` implementation against a fake secret backend — no network/DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import {
  LoginStateError,
  isSafeRelativePath,
  signLoginState,
  verifyLoginState,
} from './loginState';

const SIGNING_KEY = 'test-jwt-signing-key';

beforeEach(() => {
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JWT_SIGNING_KEY') return SIGNING_KEY;
    throw new Error(`unexpected secret ref: ${ref}`);
  });
});

afterEach(() => {
  resetSecretsForTests();
  vi.useRealTimers();
});

describe('isSafeRelativePath', () => {
  it('accepts a simple relative path', () => {
    expect(isSafeRelativePath('/settings')).toBe(true);
    expect(isSafeRelativePath('/a/b/c')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isSafeRelativePath('')).toBe(false);
  });

  it('rejects a path not starting with /', () => {
    expect(isSafeRelativePath('settings')).toBe(false);
  });

  it('rejects protocol-relative //evil.com', () => {
    expect(isSafeRelativePath('//evil.com')).toBe(false);
  });

  it('rejects backslash trick /\\evil', () => {
    expect(isSafeRelativePath('/\\evil')).toBe(false);
  });

  it('rejects an absolute URL with a scheme', () => {
    expect(isSafeRelativePath('https://evil.com')).toBe(false);
    expect(isSafeRelativePath('/x:y')).toBe(false);
  });

  it('rejects a path containing whitespace or control characters', () => {
    expect(isSafeRelativePath('/a b')).toBe(false);
    expect(isSafeRelativePath('/a\nb')).toBe(false);
    expect(isSafeRelativePath('/a\tb')).toBe(false);
  });
});

describe('signLoginState / verifyLoginState', () => {
  it('round-trips with no redirect_to', async () => {
    const token = await signLoginState();
    const state = await verifyLoginState(token);
    expect(state.purpose).toBe('login_oauth');
    expect(typeof state.nonce).toBe('string');
    expect(state.nonce.length).toBeGreaterThan(0);
    expect(state.redirect_to).toBeUndefined();
  });

  it('never carries an org_id claim', async () => {
    const token = await signLoginState();
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.org_id).toBeUndefined();
  });

  it('round-trips a validated redirect_to', async () => {
    const token = await signLoginState({ redirectTo: '/dashboard' });
    const state = await verifyLoginState(token);
    expect(state.redirect_to).toBe('/dashboard');
  });

  it('drops an unsafe redirect_to at sign time (not signed)', async () => {
    const token = await signLoginState({ redirectTo: '//evil.com' });
    const state = await verifyLoginState(token);
    expect(state.redirect_to).toBeUndefined();
  });

  it('produces a different nonce on each call', async () => {
    const a = await verifyLoginState(await signLoginState());
    const b = await verifyLoginState(await signLoginState());
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('signs an HS256 JWT via env://JWT_SIGNING_KEY', async () => {
    const token = await signLoginState();
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
    expect(() => jwt.verify(token, SIGNING_KEY)).not.toThrow();
  });

  it('rejects a tampered signature', async () => {
    const token = await signLoginState();
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'aa' ? 'bb' : 'aa'}`;
    await expect(verifyLoginState(tampered)).rejects.toBeInstanceOf(LoginStateError);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign(
      { nonce: 'x', purpose: 'login_oauth' },
      'wrong-secret',
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifyLoginState(forged)).rejects.toBeInstanceOf(LoginStateError);
  });

  it('rejects garbage input', async () => {
    await expect(verifyLoginState('not-a-jwt')).rejects.toBeInstanceOf(LoginStateError);
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await signLoginState();
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z')); // 11 minutes later, past the 10m expiry
    await expect(verifyLoginState(token)).rejects.toBeInstanceOf(LoginStateError);
  });

  it('rejects a missing purpose claim', async () => {
    const missingPurpose = jwt.sign({ nonce: 'x' }, SIGNING_KEY, {
      algorithm: 'HS256',
      expiresIn: '10m',
    });
    await expect(verifyLoginState(missingPurpose)).rejects.toBeInstanceOf(LoginStateError);
  });

  it('rejects a structurally valid JWT missing nonce', async () => {
    const missingNonce = jwt.sign({ purpose: 'login_oauth' }, SIGNING_KEY, {
      algorithm: 'HS256',
      expiresIn: '10m',
    });
    await expect(verifyLoginState(missingNonce)).rejects.toBeInstanceOf(LoginStateError);
  });

  it('re-validates redirect_to at verify time and drops it if no longer safe', async () => {
    const forgedUnsafeRedirect = jwt.sign(
      { nonce: 'x', purpose: 'login_oauth', redirect_to: '//evil.com' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    const state = await verifyLoginState(forgedUnsafeRedirect);
    expect(state.redirect_to).toBeUndefined();
  });

  describe('cross-family rejection (purpose confusion)', () => {
    it('rejects a github_app_install-purpose token presented as login state', async () => {
      const installStateToken = jwt.sign(
        { org_id: 'org-1', nonce: 'x', purpose: 'github_app_install' },
        SIGNING_KEY,
        { algorithm: 'HS256', expiresIn: '10m' },
      );
      await expect(verifyLoginState(installStateToken)).rejects.toBeInstanceOf(LoginStateError);
    });

    it('rejects a session-purpose token presented as login state', async () => {
      const sessionToken = jwt.sign(
        { sub: 'user-1', org_id: 'org-1', roles: ['owner'], purpose: 'session' },
        SIGNING_KEY,
        { algorithm: 'HS256', expiresIn: '12h' },
      );
      await expect(verifyLoginState(sessionToken)).rejects.toBeInstanceOf(LoginStateError);
    });

    it('rejects a token with an unrelated purpose string', async () => {
      const other = jwt.sign({ nonce: 'x', purpose: 'something_else' }, SIGNING_KEY, {
        algorithm: 'HS256',
        expiresIn: '10m',
      });
      await expect(verifyLoginState(other)).rejects.toBeInstanceOf(LoginStateError);
    });
  });
});

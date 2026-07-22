// Unit tests for the stateless session bearer token: round-trip, expiry,
// tamper, wrong-purpose, and structural-claim rejection. Uses the real
// `jsonwebtoken` implementation against a fake secret backend — no network/DB.
// Mirrors github/installState.test.ts's structure and discipline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import { SessionTokenError, signSessionToken, verifySessionToken } from './sessionToken';

const SIGNING_KEY = 'test-jwt-signing-key';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

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

describe('signSessionToken / verifySessionToken', () => {
  it('round-trips userId/orgId/roles through sign -> verify', async () => {
    const token = await signSessionToken({ userId: 'user-1', orgId: ORG_ID, roles: ['admin'] });
    const claims = await verifySessionToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.org_id).toBe(ORG_ID);
    expect(claims.roles).toEqual(['admin']);
    expect(claims.purpose).toBe('session');
  });

  it('signs an HS256 JWT via env://JWT_SIGNING_KEY, default 12h expiry', async () => {
    const token = await signSessionToken({ userId: 'user-1', orgId: ORG_ID, roles: ['owner'] });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
    expect(() => jwt.verify(token, SIGNING_KEY)).not.toThrow();
    const payload = decoded?.payload as { exp: number; iat: number };
    expect(payload.exp - payload.iat).toBe(12 * 60 * 60);
  });

  it('accepts multiple roles', async () => {
    const token = await signSessionToken({
      userId: 'user-1',
      orgId: ORG_ID,
      roles: ['member', 'admin'],
    });
    const claims = await verifySessionToken(token);
    expect(claims.roles).toEqual(['member', 'admin']);
  });

  it('rejects a tampered signature', async () => {
    const token = await signSessionToken({ userId: 'user-1', orgId: ORG_ID, roles: ['owner'] });
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'aa' ? 'bb' : 'aa'}`;
    await expect(verifySessionToken(tampered)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign(
      { sub: 'attacker', org_id: ORG_ID, roles: ['owner'], purpose: 'session' },
      'wrong-secret',
      { algorithm: 'HS256', expiresIn: '12h' },
    );
    await expect(verifySessionToken(forged)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects garbage input', async () => {
    await expect(verifySessionToken('not-a-jwt')).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await signSessionToken({ userId: 'user-1', orgId: ORG_ID, roles: ['owner'] });
    vi.setSystemTime(new Date('2026-01-01T13:00:00Z')); // 13h later, past the 12h default expiry
    await expect(verifySessionToken(token)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects a token with a missing purpose claim', async () => {
    const noPurpose = jwt.sign({ sub: 'user-1', org_id: ORG_ID, roles: ['owner'] }, SIGNING_KEY, {
      algorithm: 'HS256',
      expiresIn: '12h',
    });
    await expect(verifySessionToken(noPurpose)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects an install-state token replayed as a session token (wrong purpose)', async () => {
    const installStateToken = jwt.sign(
      { org_id: ORG_ID, nonce: 'x', purpose: 'github_app_install' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifySessionToken(installStateToken)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects a missing/empty sub claim', async () => {
    const missingSub = jwt.sign({ org_id: ORG_ID, roles: ['owner'], purpose: 'session' }, SIGNING_KEY, {
      algorithm: 'HS256',
      expiresIn: '12h',
    });
    await expect(verifySessionToken(missingSub)).rejects.toBeInstanceOf(SessionTokenError);

    const emptySub = jwt.sign(
      { sub: '', org_id: ORG_ID, roles: ['owner'], purpose: 'session' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '12h' },
    );
    await expect(verifySessionToken(emptySub)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects a missing org_id claim', async () => {
    const missingOrg = jwt.sign({ sub: 'user-1', roles: ['owner'], purpose: 'session' }, SIGNING_KEY, {
      algorithm: 'HS256',
      expiresIn: '12h',
    });
    await expect(verifySessionToken(missingOrg)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects a non-UUID org_id (never reaches withOrgContext)', async () => {
    const notUuid = jwt.sign(
      { sub: 'user-1', org_id: 'org_dev_local', roles: ['owner'], purpose: 'session' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '12h' },
    );
    await expect(verifySessionToken(notUuid)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects an empty roles array', async () => {
    const emptyRoles = jwt.sign(
      { sub: 'user-1', org_id: ORG_ID, roles: [], purpose: 'session' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '12h' },
    );
    await expect(verifySessionToken(emptyRoles)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects roles containing an unknown string (does not silently drop it)', async () => {
    const unknownRole = jwt.sign(
      { sub: 'user-1', org_id: ORG_ID, roles: ['superuser'], purpose: 'session' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '12h' },
    );
    await expect(verifySessionToken(unknownRole)).rejects.toBeInstanceOf(SessionTokenError);

    const mixedRoles = jwt.sign(
      { sub: 'user-1', org_id: ORG_ID, roles: ['member', 'superuser'], purpose: 'session' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '12h' },
    );
    await expect(verifySessionToken(mixedRoles)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('rejects a well-formed JWT whose payload is not a JSON object (e.g. a bare string payload)', async () => {
    // jsonwebtoken normally rejects non-object payloads at sign time for our usage,
    // so construct a token by hand: header.payload.signature where payload is a
    // base64url-encoded JSON string literal, not an object.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify('just-a-string')).toString('base64url');
    const crypto = await import('node:crypto');
    const signature = crypto
      .createHmac('sha256', SIGNING_KEY)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const token = `${header}.${payload}.${signature}`;

    await expect(verifySessionToken(token)).rejects.toBeInstanceOf(SessionTokenError);
  });

  it('never leaks which check failed — all failures throw the same error type/shape', async () => {
    const tampered = 'a.b.c';
    try {
      await verifySessionToken(tampered);
      throw new Error('expected verifySessionToken to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionTokenError);
      expect((err as Error).message).not.toMatch(/sub|org_id|roles|purpose|signature/i);
    }
  });
});

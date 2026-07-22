// Direct unit tests for ws/auth.ts's own implementation (not the injected-dep
// fakes used elsewhere in the suite). Two things are deliberately exercised
// for real here, per W2-03's spec.md edge cases and O-4:
//
//  1. extractUpgradeToken never reads a token from the request URL/query
//     string, only the Authorization header (security-multitenancy.md:
//     tokens must never land in access logs / browser history).
//  2. authenticateConnectionToken is a thin wrapper over @sayre/core's REAL
//     verifySessionToken (O-4: "no second, divergent implementation") — this
//     test signs a real token with the real sessionToken module and round-trips
//     it through the gateway's wrapper, rather than mocking `authenticate`
//     everywhere else in the suite does. A regression here (e.g. a typo'd
//     claim mapping) would not be caught by any other gateway test, since
//     every other test file injects a fake `authenticate`.

import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests, resetSecretsForTests, setConfigOverrideForTests, setSecretBackendForTests } from '@sayre/config';
// Deep import, TEST-ONLY: @sayre/core's public library surface (src/lib.ts)
// deliberately does not export `signSessionToken` (O-4 keeps that export list
// narrow to verify/validate helpers only). Reaching into the built module here
// to mint a real token is the only way to exercise the gateway's wrapper
// against the real implementation instead of a fake.
import { signSessionToken } from '@sayre/core/dist/auth/sessionToken';
import {
  authenticateConnectionToken,
  devConnectionIdentity,
  extractUpgradeToken,
  isDevOrTestEnvironment,
} from './auth';

const SIGNING_KEY = 'test-jwt-signing-key';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

function fakeReq(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { headers: {}, url: '/', ...overrides } as unknown as IncomingMessage;
}

describe('extractUpgradeToken', () => {
  it('reads a well-formed Authorization: Bearer header', () => {
    const req = fakeReq({ headers: { authorization: 'Bearer real-token' } as never });
    expect(extractUpgradeToken(req)).toBe('real-token');
  });

  it('returns undefined when there is no Authorization header at all', () => {
    const req = fakeReq({ url: '/?token=evil-in-the-url' });
    expect(extractUpgradeToken(req)).toBeUndefined();
  });

  it('never reads a token from the URL query string, even when no header is present', () => {
    // Simulates a client trying to smuggle a token via the WS upgrade URL
    // (which would land in access logs / browser history) instead of the
    // Authorization header. extractUpgradeToken must not fall back to it.
    const req = fakeReq({ url: '/socket?token=leaked-token&auth=Bearer%20leaked-token' });
    expect(extractUpgradeToken(req)).toBeUndefined();
  });

  it('ignores a malformed (non-Bearer) Authorization header', () => {
    const req = fakeReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } as never });
    expect(extractUpgradeToken(req)).toBeUndefined();
  });

  it('ignores an empty Authorization header', () => {
    const req = fakeReq({ headers: { authorization: '' } as never });
    expect(extractUpgradeToken(req)).toBeUndefined();
  });
});

describe('isDevOrTestEnvironment', () => {
  afterEach(() => {
    resetConfigForTests();
  });

  it('is true for NODE_ENV=test', () => {
    setConfigOverrideForTests('NODE_ENV', 'test');
    expect(isDevOrTestEnvironment()).toBe(true);
  });

  it('is true for NODE_ENV=development', () => {
    setConfigOverrideForTests('NODE_ENV', 'development');
    expect(isDevOrTestEnvironment()).toBe(true);
  });

  it('is false for NODE_ENV=production', () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    expect(isDevOrTestEnvironment()).toBe(false);
  });
});

describe('devConnectionIdentity', () => {
  afterEach(() => {
    resetConfigForTests();
  });

  it('returns a synthetic identity in dev/test', () => {
    setConfigOverrideForTests('NODE_ENV', 'test');
    const identity = devConnectionIdentity();
    expect(identity.roles).toEqual(['owner']);
    expect(identity.token).toBe('');
    expect(identity.orgId).toBeTruthy();
    expect(identity.userId).toBeTruthy();
  });

  it('fails closed (throws) outside development/test', () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    expect(() => devConnectionIdentity()).toThrow();
  });
});

describe('authenticateConnectionToken (against the REAL @sayre/core verifySessionToken)', () => {
  beforeEach(() => {
    setSecretBackendForTests(async (ref) => {
      if (ref === 'env://JWT_SIGNING_KEY') return SIGNING_KEY;
      throw new Error(`unexpected secret ref: ${ref}`);
    });
  });

  afterEach(() => {
    resetSecretsForTests();
  });

  it('maps a genuinely signed token onto ConnectionIdentity: org_id->orgId, sub->userId, roles preserved, token forwarded', async () => {
    const token = await signSessionToken({ userId: 'user-42', orgId: ORG_ID, roles: ['admin', 'member'] });

    const identity = await authenticateConnectionToken(token);

    expect(identity.orgId).toBe(ORG_ID);
    expect(identity.userId).toBe('user-42');
    expect(identity.roles).toEqual(['admin', 'member']);
    expect(identity.token).toBe(token);
  });

  it('propagates a uniform failure for a tampered token, never leaking which check failed', async () => {
    const token = await signSessionToken({ userId: 'user-1', orgId: ORG_ID, roles: ['member'] });
    const tampered = `${token.slice(0, -2)}xx`;

    await expect(authenticateConnectionToken(tampered)).rejects.toThrow();
  });

  it('propagates a uniform failure for a garbage (non-JWT) token', async () => {
    await expect(authenticateConnectionToken('not-a-jwt-at-all')).rejects.toThrow();
  });
});

// Unit tests for the signed install-state token: round-trip, expiry, tamper,
// and wrong-purpose rejection. Uses the real `jsonwebtoken` implementation
// against a fake secret backend — no network/DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import { InstallStateError, signInstallState, verifyInstallState } from './installState';

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

describe('signInstallState / verifyInstallState', () => {
  it('round-trips org_id through sign -> verify', async () => {
    const token = await signInstallState('org-123');
    const state = await verifyInstallState(token);
    expect(state.org_id).toBe('org-123');
    expect(state.purpose).toBe('github_app_install');
    expect(typeof state.nonce).toBe('string');
    expect(state.nonce.length).toBeGreaterThan(0);
  });

  it('produces a different nonce on each call (not replayable across two independent starts)', async () => {
    const a = await verifyInstallState(await signInstallState('org-1'));
    const b = await verifyInstallState(await signInstallState('org-1'));
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('signs an HS256 JWT via env://JWT_SIGNING_KEY', async () => {
    const token = await signInstallState('org-1');
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
    // Verifiable with the exact same secret the loader resolved.
    expect(() => jwt.verify(token, SIGNING_KEY)).not.toThrow();
  });

  it('rejects a tampered signature', async () => {
    const token = await signInstallState('org-1');
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'aa' ? 'bb' : 'aa'}`;
    await expect(verifyInstallState(tampered)).rejects.toBeInstanceOf(InstallStateError);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign(
      { org_id: 'org-attacker', nonce: 'x', purpose: 'github_app_install' },
      'wrong-secret',
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifyInstallState(forged)).rejects.toBeInstanceOf(InstallStateError);
  });

  it('rejects garbage input', async () => {
    await expect(verifyInstallState('not-a-jwt')).rejects.toBeInstanceOf(InstallStateError);
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await signInstallState('org-1');
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z')); // 11 minutes later, past the 10m expiry
    await expect(verifyInstallState(token)).rejects.toBeInstanceOf(InstallStateError);
  });

  it('rejects a token with the wrong purpose claim', async () => {
    const wrongPurpose = jwt.sign(
      { org_id: 'org-1', nonce: 'x', purpose: 'something_else' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifyInstallState(wrongPurpose)).rejects.toBeInstanceOf(InstallStateError);
  });

  it('rejects a structurally valid JWT missing org_id', async () => {
    const missingOrg = jwt.sign({ nonce: 'x', purpose: 'github_app_install' }, SIGNING_KEY, {
      algorithm: 'HS256',
      expiresIn: '10m',
    });
    await expect(verifyInstallState(missingOrg)).rejects.toBeInstanceOf(InstallStateError);
  });
});

// Unit tests for the signed Jira connect-state token: round-trip, expiry,
// tamper, and cross-family purpose rejection. Mirrors
// services/core/src/github/installState.test.ts's structure/coverage for the
// sibling state module. Real `jsonwebtoken` implementation against a fake
// secret backend — no network/DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import {
  JiraConnectStateError,
  signJiraConnectState,
  verifyJiraConnectState,
} from './jiraConnectState';

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

describe('signJiraConnectState / verifyJiraConnectState', () => {
  it('round-trips org_id, user_id, and user_label through sign -> verify', async () => {
    const token = await signJiraConnectState({
      orgId: 'org-123',
      userId: 'user-456',
      userLabel: 'Alex Kwon',
    });
    const state = await verifyJiraConnectState(token);
    expect(state.org_id).toBe('org-123');
    expect(state.user_id).toBe('user-456');
    expect(state.user_label).toBe('Alex Kwon');
    expect(state.purpose).toBe('jira_oauth_connect');
    expect(typeof state.nonce).toBe('string');
    expect(state.nonce.length).toBeGreaterThan(0);
  });

  it('produces a different nonce on each call (not replayable across two independent starts)', async () => {
    const a = await verifyJiraConnectState(
      await signJiraConnectState({ orgId: 'org-1', userId: 'user-1', userLabel: 'A' }),
    );
    const b = await verifyJiraConnectState(
      await signJiraConnectState({ orgId: 'org-1', userId: 'user-1', userLabel: 'A' }),
    );
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('signs an HS256 JWT via env://JWT_SIGNING_KEY', async () => {
    const token = await signJiraConnectState({ orgId: 'org-1', userId: 'user-1', userLabel: 'A' });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
    expect(() => jwt.verify(token, SIGNING_KEY)).not.toThrow();
  });

  it('rejects a tampered signature', async () => {
    const token = await signJiraConnectState({ orgId: 'org-1', userId: 'user-1', userLabel: 'A' });
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'aa' ? 'bb' : 'aa'}`;
    await expect(verifyJiraConnectState(tampered)).rejects.toBeInstanceOf(JiraConnectStateError);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign(
      {
        org_id: 'org-attacker',
        user_id: 'user-attacker',
        user_label: 'Attacker',
        nonce: 'x',
        purpose: 'jira_oauth_connect',
      },
      'wrong-secret',
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifyJiraConnectState(forged)).rejects.toBeInstanceOf(JiraConnectStateError);
  });

  it('rejects garbage input', async () => {
    await expect(verifyJiraConnectState('not-a-jwt')).rejects.toBeInstanceOf(JiraConnectStateError);
  });

  it('rejects an expired token (10-minute expiry)', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await signJiraConnectState({ orgId: 'org-1', userId: 'user-1', userLabel: 'A' });
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z')); // 11 minutes later, past the 10m expiry
    await expect(verifyJiraConnectState(token)).rejects.toBeInstanceOf(JiraConnectStateError);
  });

  it('rejects a structurally valid JWT missing org_id', async () => {
    const missingOrg = jwt.sign(
      { user_id: 'user-1', user_label: 'A', nonce: 'x', purpose: 'jira_oauth_connect' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifyJiraConnectState(missingOrg)).rejects.toBeInstanceOf(JiraConnectStateError);
  });

  it('rejects a structurally valid JWT missing user_id', async () => {
    const missingUser = jwt.sign(
      { org_id: 'org-1', user_label: 'A', nonce: 'x', purpose: 'jira_oauth_connect' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifyJiraConnectState(missingUser)).rejects.toBeInstanceOf(JiraConnectStateError);
  });

  it('rejects a structurally valid JWT missing user_label', async () => {
    const missingLabel = jwt.sign(
      { org_id: 'org-1', user_id: 'user-1', nonce: 'x', purpose: 'jira_oauth_connect' },
      SIGNING_KEY,
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    await expect(verifyJiraConnectState(missingLabel)).rejects.toBeInstanceOf(JiraConnectStateError);
  });

  // Security-critical (spec.md): `purpose` is the ONLY thing preventing a
  // github_app_install / login_oauth / session token (all sharing the SAME
  // JWT_SIGNING_KEY) from being replayed as a Jira connect-state token.
  describe('cross-family rejection (purpose confusion)', () => {
    it('rejects a real github_app_install-purpose token presented as Jira connect state', async () => {
      const installStateToken = jwt.sign(
        { org_id: 'org-1', nonce: 'x', purpose: 'github_app_install' },
        SIGNING_KEY,
        { algorithm: 'HS256', expiresIn: '10m' },
      );
      await expect(verifyJiraConnectState(installStateToken)).rejects.toBeInstanceOf(
        JiraConnectStateError,
      );
    });

    it('rejects a real login_oauth-purpose token presented as Jira connect state', async () => {
      const loginStateToken = jwt.sign(
        { nonce: 'x', purpose: 'login_oauth' },
        SIGNING_KEY,
        { algorithm: 'HS256', expiresIn: '10m' },
      );
      await expect(verifyJiraConnectState(loginStateToken)).rejects.toBeInstanceOf(
        JiraConnectStateError,
      );
    });

    it('rejects a real session-purpose token presented as Jira connect state', async () => {
      const sessionToken = jwt.sign(
        { sub: 'user-1', org_id: 'org-1', roles: ['owner'], purpose: 'session' },
        SIGNING_KEY,
        { algorithm: 'HS256', expiresIn: '12h' },
      );
      await expect(verifyJiraConnectState(sessionToken)).rejects.toBeInstanceOf(
        JiraConnectStateError,
      );
    });

    it('rejects a github_app_install token even when it forges user_id/user_label claims', async () => {
      const forged = jwt.sign(
        {
          org_id: 'org-1',
          user_id: 'forged-admin',
          user_label: 'Forged Admin',
          nonce: 'x',
          purpose: 'github_app_install',
        },
        SIGNING_KEY,
        { algorithm: 'HS256', expiresIn: '10m' },
      );
      await expect(verifyJiraConnectState(forged)).rejects.toBeInstanceOf(JiraConnectStateError);
    });
  });
});

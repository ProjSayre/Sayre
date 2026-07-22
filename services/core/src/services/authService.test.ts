import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { SessionTokenError } from '../auth/sessionToken';
import { devSessionContext, resolveSessionContext } from './authService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  resetConfigForTests();
});

describe('resolveSessionContext', () => {
  it('maps verified claims to a UserAuthContext with exactly the expected shape', async () => {
    const verifyToken = vi.fn(async () => ({
      sub: 'user-1',
      org_id: ORG_ID,
      roles: ['admin'] as const,
      purpose: 'session' as const,
    }));

    const context = await resolveSessionContext('some-token', { verifyToken });

    expect(context).toEqual({
      subjectType: 'user',
      userId: 'user-1',
      orgId: ORG_ID,
      roles: ['admin'],
    });
    expect(verifyToken).toHaveBeenCalledWith('some-token');
  });

  it('propagates SessionTokenError from the injected verifier', async () => {
    const verifyToken = vi.fn(async () => {
      throw new SessionTokenError();
    });

    await expect(resolveSessionContext('bad-token', { verifyToken })).rejects.toBeInstanceOf(
      SessionTokenError,
    );
  });

  it('defaults to the real verifySessionToken when no deps are injected', async () => {
    // No secret backend configured -> getSecret will fail, proving the real
    // verifier (not a no-op) is wired in by default.
    await expect(resolveSessionContext('any-token')).rejects.toThrow();
  });
});

describe('devSessionContext', () => {
  it('builds { subjectType: "user", userId: DEV_USER_ID, orgId: DEV_ORG_ID, roles: ["owner"] } in test', () => {
    setConfigOverrideForTests('NODE_ENV', 'test');
    setConfigOverrideForTests('DEV_ORG_ID', 'org_env_configured');
    setConfigOverrideForTests('DEV_USER_ID', 'user_env_configured');

    const context = devSessionContext();

    expect(context).toEqual({
      subjectType: 'user',
      userId: 'user_env_configured',
      orgId: 'org_env_configured',
      roles: ['owner'],
    });
  });

  it('falls back to user_dev_local / org_dev_local defaults when unset', () => {
    setConfigOverrideForTests('NODE_ENV', 'test');
    setConfigOverrideForTests('DEV_ORG_ID', undefined);
    setConfigOverrideForTests('DEV_USER_ID', undefined);

    const context = devSessionContext();

    expect(context.userId).toBe('user_dev_local');
    expect(context.orgId).toBe('org_dev_local');
  });

  it('works in development too', () => {
    setConfigOverrideForTests('NODE_ENV', 'development');
    const context = devSessionContext();
    expect(context.subjectType).toBe('user');
  });

  it('fails closed (throws) in production even when DEV_USER_ID/DEV_ORG_ID are configured', () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    setConfigOverrideForTests('DEV_ORG_ID', 'must-not-be-used');
    setConfigOverrideForTests('DEV_USER_ID', 'must-not-be-used');

    expect(() => devSessionContext()).toThrow();
  });
});

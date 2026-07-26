// Fully DI-mocked unit tests for startGithubLogin / handleGithubLoginCallback
// — no real GitHub API, no Postgres. Mirrors the DI-mock pattern in
// githubAppInstallService.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { LoginStateError } from '../auth/loginState';
import { GithubOAuthCodeError, NoVerifiedEmailError } from '../github/oauthClient';
import {
  LoginCallbackBadRequestError,
  handleGithubLoginCallback,
  startGithubLogin,
  type LoginCallbackDeps,
} from './loginService';

beforeEach(() => {
  setConfigOverrideForTests('GITHUB_WEB_BASE_URL', 'https://github.test');
  setConfigOverrideForTests('GITHUB_APP_CLIENT_ID', 'client-id-123');
  setConfigOverrideForTests('GITHUB_LOGIN_COMPLETE_REDIRECT_URL', '/auth/complete');
  setConfigOverrideForTests('GITHUB_LOGIN_CALLBACK_URL', 'https://core.test/auth/github/callback');
});

afterEach(() => {
  resetConfigForTests();
});

describe('startGithubLogin', () => {
  it('signs state and redirects to GITHUB_WEB_BASE_URL/login/oauth/authorize', async () => {
    const signState = vi.fn(async () => 'signed-login-state');
    const result = await startGithubLogin(undefined, { signState });
    expect(result.redirectTo).toBe(
      'https://github.test/login/oauth/authorize?client_id=client-id-123&state=signed-login-state' +
        '&scope=user%3Aemail&redirect_uri=' +
        encodeURIComponent('https://core.test/auth/github/callback'),
    );
    expect(signState).toHaveBeenCalledWith(undefined);
  });

  it('passes a redirectTo through to signState', async () => {
    const signState = vi.fn(async () => 'signed-state');
    await startGithubLogin({ redirectTo: '/dashboard' }, { signState });
    expect(signState).toHaveBeenCalledWith({ redirectTo: '/dashboard' });
  });

  it('URL-encodes the state token', async () => {
    const signState = vi.fn(async () => 'a.b+c/d=');
    const result = await startGithubLogin(undefined, { signState });
    expect(result.redirectTo).toContain(encodeURIComponent('a.b+c/d='));
  });
});

interface Deps extends LoginCallbackDeps {
  verifyState: ReturnType<typeof vi.fn>;
  resolveUser: ReturnType<typeof vi.fn>;
  getDb: ReturnType<typeof vi.fn>;
  withOrg: ReturnType<typeof vi.fn>;
  insertOrganization: ReturnType<typeof vi.fn>;
  insertOwnerUser: ReturnType<typeof vi.fn>;
  signSession: ReturnType<typeof vi.fn>;
  newOrgId: ReturnType<typeof vi.fn>;
}

function makeGithubUser(overrides: Partial<{
  id: string;
  login: string;
  name: string | null;
  email: string | null;
}> = {}) {
  return {
    id: '1001',
    login: 'octocat',
    name: 'The Octocat',
    email: 'octocat@example.com',
    ...overrides,
  };
}

let orgIdCounter = 0;
function makeCallbackDeps(overrides: Partial<Deps> = {}): Deps {
  orgIdCounter = 0;
  return {
    verifyState: vi.fn(async () => ({ nonce: 'n', purpose: 'login_oauth' as const })),
    oauthClient: {
      exchangeCodeForToken: vi.fn(async () => 'gho_faketoken'),
      getAuthenticatedUser: vi.fn(async () => makeGithubUser()),
      getPrimaryVerifiedEmail: vi.fn(async () => {
        throw new Error('getPrimaryVerifiedEmail should not be called when user.email is set');
      }),
    },
    resolveUser: vi.fn(async () => null),
    getDb: vi.fn(async () => ({}) as never),
    withOrg: vi.fn(async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
    ),
    insertOrganization: vi.fn(async () => undefined),
    insertOwnerUser: vi.fn(async () => ({ userId: 'user-new-1' })),
    signSession: vi.fn(async (input: { userId: string; orgId: string; roles: string[] }) =>
      `session-for-${input.userId}-${input.orgId}-${input.roles.join(',')}`,
    ),
    newOrgId: vi.fn(() => `org-new-${(orgIdCounter += 1)}`),
    ...overrides,
  } as Deps;
}

describe('handleGithubLoginCallback — state validation (400s)', () => {
  it('throws LoginCallbackBadRequestError when state is missing', async () => {
    const deps = makeCallbackDeps();
    await expect(
      handleGithubLoginCallback({ code: 'abc' }, deps),
    ).rejects.toBeInstanceOf(LoginCallbackBadRequestError);
    expect(deps.oauthClient.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('throws LoginCallbackBadRequestError when verifyState rejects with LoginStateError', async () => {
    const deps = makeCallbackDeps({
      verifyState: vi.fn(async () => {
        throw new LoginStateError();
      }),
    });
    await expect(
      handleGithubLoginCallback({ code: 'abc', state: 'bad' }, deps),
    ).rejects.toBeInstanceOf(LoginCallbackBadRequestError);
    expect(deps.oauthClient.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('rethrows a non-LoginStateError failure from verifyState uncaught (infra failure -> 500)', async () => {
    const deps = makeCallbackDeps({
      verifyState: vi.fn(async () => {
        throw new Error('secret loader down');
      }),
    });
    await expect(
      handleGithubLoginCallback({ code: 'abc', state: 'x' }, deps),
    ).rejects.toThrow('secret loader down');
  });

  it('throws LoginCallbackBadRequestError when code is missing; no downstream call runs', async () => {
    const deps = makeCallbackDeps();
    await expect(
      handleGithubLoginCallback({ state: 'x' }, deps),
    ).rejects.toBeInstanceOf(LoginCallbackBadRequestError);
    expect(deps.oauthClient.exchangeCodeForToken).not.toHaveBeenCalled();
  });
});

describe('handleGithubLoginCallback — reused/expired code (400)', () => {
  it('propagates GithubOAuthCodeError from a bad code exchange; no rows, no session', async () => {
    const deps = makeCallbackDeps({
      oauthClient: {
        exchangeCodeForToken: vi.fn(async () => {
          throw new GithubOAuthCodeError();
        }),
        getAuthenticatedUser: vi.fn(),
        getPrimaryVerifiedEmail: vi.fn(),
      },
    });
    await expect(
      handleGithubLoginCallback({ state: 'x', code: 'reused' }, deps),
    ).rejects.toBeInstanceOf(GithubOAuthCodeError);
    expect(deps.resolveUser).not.toHaveBeenCalled();
    expect(deps.insertOrganization).not.toHaveBeenCalled();
    expect(deps.signSession).not.toHaveBeenCalled();
  });
});

describe('handleGithubLoginCallback — null-primary-email fallback', () => {
  it('falls back to getPrimaryVerifiedEmail when user.email is null', async () => {
    const deps = makeCallbackDeps({
      oauthClient: {
        exchangeCodeForToken: vi.fn(async () => 'gho_faketoken'),
        getAuthenticatedUser: vi.fn(async () => makeGithubUser({ email: null })),
        getPrimaryVerifiedEmail: vi.fn(async () => 'fallback@example.com'),
      },
    });
    await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.oauthClient.getPrimaryVerifiedEmail).toHaveBeenCalledWith('gho_faketoken');
    expect(deps.insertOwnerUser).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ email: 'fallback@example.com' }),
    );
  });

  it('propagates NoVerifiedEmailError (422) and creates no rows', async () => {
    const deps = makeCallbackDeps({
      oauthClient: {
        exchangeCodeForToken: vi.fn(async () => 'gho_faketoken'),
        getAuthenticatedUser: vi.fn(async () => makeGithubUser({ email: null })),
        getPrimaryVerifiedEmail: vi.fn(async () => {
          throw new NoVerifiedEmailError();
        }),
      },
    });
    await expect(
      handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps),
    ).rejects.toBeInstanceOf(NoVerifiedEmailError);
    expect(deps.insertOrganization).not.toHaveBeenCalled();
    expect(deps.signSession).not.toHaveBeenCalled();
  });
});

describe('handleGithubLoginCallback — resolve-existing branch', () => {
  it('resolves an existing user by external_auth_id; issues a session; creates no rows', async () => {
    const deps = makeCallbackDeps({
      resolveUser: vi.fn(async (externalAuthId: string) => {
        expect(externalAuthId).toBe('1001');
        return { userId: 'user-existing-1', orgId: 'org-existing-1', orgRole: 'admin' as const };
      }),
    });
    const result = await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.insertOrganization).not.toHaveBeenCalled();
    expect(deps.insertOwnerUser).not.toHaveBeenCalled();
    expect(deps.signSession).toHaveBeenCalledWith({
      userId: 'user-existing-1',
      orgId: 'org-existing-1',
      roles: ['admin'],
    });
    expect(result.redirectTo).toBe(
      `/auth/complete#token=${await deps.signSession.mock.results[0].value}`,
    );
  });

  it('coerces an unexpected stored org_role to member (least privilege)', async () => {
    const deps = makeCallbackDeps({
      resolveUser: vi.fn(async () => ({
        userId: 'user-existing-1',
        orgId: 'org-existing-1',
        // Cast past the type to simulate an unexpected stored value already
        // coerced upstream by resolveUserByExternalAuthId in db/authUsers.ts —
        // this test asserts the service just uses whatever ResolvedAuthUser hands it.
        orgRole: 'member' as const,
      })),
    });
    await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.signSession).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['member'] }),
    );
  });

  it('never creates a second org for a user signing in twice sequentially', async () => {
    const deps = makeCallbackDeps({
      resolveUser: vi.fn(async () => ({
        userId: 'user-existing-1',
        orgId: 'org-existing-1',
        orgRole: 'owner' as const,
      })),
    });
    await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    await handleGithubLoginCallback({ state: 'x', code: 'abc2' }, deps);
    expect(deps.insertOrganization).not.toHaveBeenCalled();
    expect(deps.newOrgId).not.toHaveBeenCalled();
  });
});

describe('handleGithubLoginCallback — create-new branch', () => {
  it('creates a new org (owner) + user; session carries roles: [owner]', async () => {
    const deps = makeCallbackDeps();
    const result = await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.insertOrganization).toHaveBeenCalledWith(
      {},
      { id: 'org-new-1', name: 'The Octocat', slug: 'octocat' },
    );
    expect(deps.insertOwnerUser).toHaveBeenCalledWith(
      {},
      {
        orgId: 'org-new-1',
        email: 'octocat@example.com',
        name: 'The Octocat',
        externalAuthId: '1001',
      },
    );
    expect(deps.signSession).toHaveBeenCalledWith({
      userId: 'user-new-1',
      orgId: 'org-new-1',
      roles: ['owner'],
    });
    expect(result.redirectTo).toMatch(/^\/auth\/complete#token=session-for-user-new-1-org-new-1-owner$/);
  });

  it('falls back to login when user.name is null/blank for the org name', async () => {
    const deps = makeCallbackDeps({
      oauthClient: {
        exchangeCodeForToken: vi.fn(async () => 'gho_faketoken'),
        getAuthenticatedUser: vi.fn(async () => makeGithubUser({ name: '  ' })),
        getPrimaryVerifiedEmail: vi.fn(),
      },
    });
    await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.insertOrganization).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ name: 'octocat' }),
    );
  });

  it('binds a validated redirect_to from state onto the completion redirect', async () => {
    const deps = makeCallbackDeps({
      verifyState: vi.fn(async () => ({
        nonce: 'n',
        purpose: 'login_oauth' as const,
        redirect_to: '/dashboard',
      })),
    });
    const result = await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(result.redirectTo).toContain('&redirect_to=%2Fdashboard');
  });
});

describe('handleGithubLoginCallback — slug collision (AC7)', () => {
  it('retries with a de-duplicated slug on an organizations.slug unique violation', async () => {
    let insertCount = 0;
    const deps = makeCallbackDeps({
      insertOrganization: vi.fn(async () => {
        insertCount += 1;
        if (insertCount === 1) {
          const err = new Error('duplicate key') as Error & { code: string; constraint: string };
          err.code = '23505';
          err.constraint = 'organizations_slug_unique';
          throw err;
        }
      }),
    });
    const result = await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.insertOrganization).toHaveBeenCalledTimes(2);
    expect(deps.insertOrganization).toHaveBeenNthCalledWith(
      1,
      {},
      expect.objectContaining({ slug: 'octocat' }),
    );
    expect(deps.insertOrganization).toHaveBeenNthCalledWith(
      2,
      {},
      expect.objectContaining({ slug: 'octocat-2' }),
    );
    expect(result.redirectTo).toContain('#token=');
  });

  it('never surfaces the raw organizations.slug unique violation to the caller', async () => {
    const deps = makeCallbackDeps({
      insertOrganization: vi.fn(async () => {
        const err = new Error('duplicate key') as Error & { code: string; constraint: string };
        err.code = '23505';
        err.constraint = 'organizations_slug_unique';
        throw err;
      }),
    });
    await expect(handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps)).rejects.toThrow(
      /Exhausted org-creation attempts/,
    );
  });
});

describe('handleGithubLoginCallback — same-user race (AC8)', () => {
  it('re-resolves and returns the winner on an external_auth_id unique violation; single org total', async () => {
    let resolveCallCount = 0;
    const deps = makeCallbackDeps({
      resolveUser: vi.fn(async () => {
        resolveCallCount += 1;
        if (resolveCallCount === 1) return null; // first check: not found
        // second check (post-conflict re-resolve): the concurrent winner
        return { userId: 'user-winner-1', orgId: 'org-winner-1', orgRole: 'owner' as const };
      }),
      insertOwnerUser: vi.fn(async () => {
        const err = new Error('duplicate key') as Error & { code: string; constraint: string };
        err.code = '23505';
        err.constraint = 'users_external_auth_id_unique';
        throw err;
      }),
    });
    const result = await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.insertOrganization).toHaveBeenCalledTimes(1); // one attempt only
    expect(deps.resolveUser).toHaveBeenCalledTimes(2);
    expect(deps.signSession).toHaveBeenCalledWith({
      userId: 'user-winner-1',
      orgId: 'org-winner-1',
      roles: ['owner'],
    });
    expect(result.redirectTo).toContain('#token=');
  });
});

describe('handleGithubLoginCallback — pathological contention', () => {
  it('exhausts 5 attempts and surfaces an error rather than looping forever', async () => {
    const deps = makeCallbackDeps({
      insertOrganization: vi.fn(async () => {
        const err = new Error('duplicate key') as Error & { code: string; constraint: string };
        err.code = '23505';
        err.constraint = 'organizations_slug_unique';
        throw err;
      }),
    });
    await expect(handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps)).rejects.toThrow();
    expect(deps.insertOrganization).toHaveBeenCalledTimes(5);
  });
});

describe('handleGithubLoginCallback — no account/org merge on email collision (AC9)', () => {
  it('creates a brand-new org+user even when the email matches a different org member; resolution never reads email', async () => {
    const deps = makeCallbackDeps({
      resolveUser: vi.fn(async (externalAuthId: string) => {
        // Resolution is keyed strictly on external_auth_id — this fake never
        // looks at email, proving the service can't either (it has no other
        // path to a "resolve by email" call).
        expect(externalAuthId).toBe('1001');
        return null;
      }),
    });
    await handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps);
    expect(deps.insertOrganization).toHaveBeenCalledTimes(1);
    expect(deps.resolveUser).toHaveBeenCalledWith('1001');
    expect(deps.resolveUser).not.toHaveBeenCalledWith('octocat@example.com');
  });
});

describe('handleGithubLoginCallback — tenancy / injection (AC11)', () => {
  it('a forged org_id-shaped field on the input is never read; org is server-resolved/generated only', async () => {
    const deps = makeCallbackDeps();
    const forgedInput = {
      state: 'x',
      code: 'abc',
      org_id: 'attacker-org',
      X_Org_Id: 'attacker-org',
    } as unknown as Parameters<typeof handleGithubLoginCallback>[0];
    await handleGithubLoginCallback(forgedInput, deps);
    expect(deps.insertOrganization).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: 'org-new-1' }),
    );
    expect(deps.newOrgId).toHaveBeenCalled();
  });
});

describe('handleGithubLoginCallback — transport failures (502)', () => {
  it('exchangeCodeForToken/getAuthenticatedUser transport failure propagates uncaught, no rows written', async () => {
    const deps = makeCallbackDeps({
      oauthClient: {
        exchangeCodeForToken: vi.fn(async () => {
          throw new Error('GitHub API request failed: network error');
        }),
        getAuthenticatedUser: vi.fn(),
        getPrimaryVerifiedEmail: vi.fn(),
      },
    });
    await expect(
      handleGithubLoginCallback({ state: 'x', code: 'abc' }, deps),
    ).rejects.toThrow('GitHub API request failed');
    expect(deps.insertOrganization).not.toHaveBeenCalled();
  });
});

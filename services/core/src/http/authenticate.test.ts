import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { SessionTokenError } from '../auth/sessionToken';
import type { UserAuthContext } from '../auth/context';
import { authenticate, AuthenticationError } from './authenticate';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as Request;
}

afterEach(() => {
  resetConfigForTests();
});

describe('authenticate', () => {
  it('valid Bearer token: resolves context, attaches req.context, calls next() with no error', async () => {
    const context: UserAuthContext = {
      subjectType: 'user',
      userId: 'user-1',
      orgId: ORG_ID,
      roles: ['member'],
    };
    const resolve = vi.fn(async () => context);
    const middleware = authenticate({ resolve });
    const req = makeReq({ headers: { authorization: 'Bearer good-token' } });
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(req.context).toEqual(context);
    expect(resolve).toHaveBeenCalledWith('good-token');
    expect(next).toHaveBeenCalledWith();
  });

  it('lowercase "bearer" scheme is accepted', async () => {
    const context: UserAuthContext = { subjectType: 'user', userId: 'u', orgId: ORG_ID, roles: ['member'] };
    const resolve = vi.fn(async () => context);
    const middleware = authenticate({ resolve });
    const req = makeReq({ headers: { authorization: 'bearer good-token' } });
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(resolve).toHaveBeenCalledWith('good-token');
    expect(next).toHaveBeenCalledWith();
  });

  it('tolerates leading/trailing whitespace around the header value', async () => {
    const context: UserAuthContext = { subjectType: 'user', userId: 'u', orgId: ORG_ID, roles: ['member'] };
    const resolve = vi.fn(async () => context);
    const middleware = authenticate({ resolve });
    const req = makeReq({ headers: { authorization: '  Bearer good-token  ' } });
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(resolve).toHaveBeenCalledWith('good-token');
    expect(next).toHaveBeenCalledWith();
  });

  it('SessionTokenError from resolve() maps to AuthenticationError (401), req.context stays unset', async () => {
    const resolve = vi.fn(async () => {
      throw new SessionTokenError();
    });
    const middleware = authenticate({ resolve });
    const req = makeReq({ headers: { authorization: 'Bearer bad-token' } });
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(req.context).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('a non-SessionTokenError from resolve() (e.g. getSecret failure) propagates as-is (-> 500, not 401)', async () => {
    const boom = new Error('secret backend unavailable');
    const resolve = vi.fn(async () => {
      throw boom;
    });
    const middleware = authenticate({ resolve });
    const req = makeReq({ headers: { authorization: 'Bearer any-token' } });
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  it('no Authorization header, NODE_ENV=test: dev fallback context attached, next() called clean', async () => {
    setConfigOverrideForTests('NODE_ENV', 'test');
    setConfigOverrideForTests('DEV_ORG_ID', 'org_dev_local');
    setConfigOverrideForTests('DEV_USER_ID', 'user_dev_local');
    const resolve = vi.fn();
    const middleware = authenticate({ resolve });
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(req.context).toEqual({
      subjectType: 'user',
      userId: 'user_dev_local',
      orgId: 'org_dev_local',
      roles: ['owner'],
    });
    expect(next).toHaveBeenCalledWith();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('no Authorization header, NODE_ENV=production: 401, no req.context, resolve never called', async () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const resolve = vi.fn();
    const middleware = authenticate({ resolve });
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(req.context).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['Basic dXNlcjpwYXNz', 'wrong scheme'],
    ['', 'empty header value'],
    ['Bearer', 'Bearer with no token'],
    ['Bearer   ', 'Bearer with only whitespace'],
  ])('rejects malformed Authorization header "%s" (%s) in production', async (headerValue) => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    const resolve = vi.fn();
    const middleware = authenticate({ resolve });
    const req = makeReq({ headers: { authorization: headerValue } });
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never reads orgId/userId/roles from query, body, or headers other than the token', async () => {
    const context: UserAuthContext = { subjectType: 'user', userId: 'u', orgId: ORG_ID, roles: ['member'] };
    const resolve = vi.fn(async () => context);
    const middleware = authenticate({ resolve });
    const req = makeReq({
      headers: { authorization: 'Bearer good-token', 'x-org-id': 'attacker-org', 'x-user-id': 'attacker', 'x-roles': 'owner' },
      query: { orgId: 'attacker-org' },
      body: { orgId: 'attacker-org' },
    } as unknown as Partial<Request>);
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    expect(req.context).toEqual(context);
    expect(resolve).toHaveBeenCalledWith('good-token');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Basic dXNlcjpwYXNz', 'wrong scheme'],
    ['Bearer', 'Bearer with no token'],
  ])(
    'TESTER GAP CHECK: malformed Authorization header "%s" (%s) in NODE_ENV=test — documents actual behavior against the spec\'s unqualified "-> 401" edge case',
    async (headerValue) => {
      setConfigOverrideForTests('NODE_ENV', 'test');
      setConfigOverrideForTests('DEV_ORG_ID', 'org_dev_local');
      setConfigOverrideForTests('DEV_USER_ID', 'user_dev_local');
      const resolve = vi.fn();
      const middleware = authenticate({ resolve });
      const req = makeReq({ headers: { authorization: headerValue } });
      const next = vi.fn() as unknown as NextFunction;

      await middleware(req, {} as Response, next);

      // spec.md's edge-case list states, without an environment qualifier:
      // "Authorization present but not Bearer <x> ... -> 401". The
      // implementation only special-cases *no* Authorization header for the
      // dev/test fallback (`extractBearerToken` returns undefined for both an
      // absent header AND a malformed one, and authenticate() cannot tell
      // them apart once that happens) — so a malformed header in NODE_ENV=test
      // is silently treated as "no credential" and gets the dev fallback
      // context instead of a 401. This assertion pins that ACTUAL behavior;
      // see test-results.md for whether this is a real gap vs. spec.md
      // ambiguity for review to decide.
      expect(next).toHaveBeenCalledWith();
      expect(req.context).toEqual({
        subjectType: 'user',
        userId: 'user_dev_local',
        orgId: 'org_dev_local',
        roles: ['owner'],
      });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('TESTER GAP CHECK: NODE_ENV entirely unset (not just non-dev/test) fails closed — no silent dev-context fallback', async () => {
    setConfigOverrideForTests('NODE_ENV', undefined);
    const resolve = vi.fn();
    const middleware = authenticate({ resolve });
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    await middleware(req, {} as Response, next);

    // getConfig('NODE_ENV') has no DEFAULTS entry (packages/config/src/config.ts),
    // so an unset NODE_ENV throws ConfigError inside authenticate()'s try/catch.
    // That is NOT a SessionTokenError, so it propagates via next(err) as-is,
    // which errorHandler maps to a generic 500 — never the dev fallback and
    // never a silent pass-through. This is the "fail-closed" property the
    // ticket asked to be verified.
    expect(req.context).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    const errArg = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(errArg).toBeInstanceOf(Error);
    expect(errArg).not.toBeInstanceOf(AuthenticationError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('concurrent requests with different tokens each resolve their own context (no shared mutable state)', async () => {
    const contextA: UserAuthContext = { subjectType: 'user', userId: 'a', orgId: 'org-a', roles: ['member'] };
    const contextB: UserAuthContext = { subjectType: 'user', userId: 'b', orgId: 'org-b', roles: ['member'] };
    const resolve = vi.fn(async (token: string) => (token === 'token-a' ? contextA : contextB));
    const middleware = authenticate({ resolve });

    const reqA = makeReq({ headers: { authorization: 'Bearer token-a' } });
    const reqB = makeReq({ headers: { authorization: 'Bearer token-b' } });
    const nextA = vi.fn() as unknown as NextFunction;
    const nextB = vi.fn() as unknown as NextFunction;

    await Promise.all([
      middleware(reqA, {} as Response, nextA),
      middleware(reqB, {} as Response, nextB),
    ]);

    expect(reqA.context).toEqual(contextA);
    expect(reqB.context).toEqual(contextB);
  });
});

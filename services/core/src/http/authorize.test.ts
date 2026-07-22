import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AuthContext } from '../auth/context';
import { authorize, AuthorizationError } from './authorize';
import { AuthenticationError } from './authenticate';

function makeReq(context?: AuthContext): Request {
  return { context } as Request;
}

describe('authorize', () => {
  it('roles:["member"] vs authorize("admin") -> 403 (AuthorizationError)', () => {
    const req = makeReq({ subjectType: 'user', userId: 'u', orgId: 'org', roles: ['member'] });
    const next = vi.fn() as unknown as NextFunction;

    authorize('admin')(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthorizationError));
  });

  it('roles:["member"] vs authorize("member") -> passes', () => {
    const req = makeReq({ subjectType: 'user', userId: 'u', orgId: 'org', roles: ['member'] });
    const next = vi.fn() as unknown as NextFunction;

    authorize('member')(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('roles:["owner"] passes both authorize("admin") and authorize("member")', () => {
    const req = makeReq({ subjectType: 'user', userId: 'u', orgId: 'org', roles: ['owner'] });

    const nextAdmin = vi.fn() as unknown as NextFunction;
    authorize('admin')(req, {} as Response, nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith();

    const nextMember = vi.fn() as unknown as NextFunction;
    authorize('member')(req, {} as Response, nextMember);
    expect(nextMember).toHaveBeenCalledWith();
  });

  it('roles:["admin"] passes authorize("admin") and authorize("member") but not implied owner-only gates', () => {
    const req = makeReq({ subjectType: 'user', userId: 'u', orgId: 'org', roles: ['admin'] });

    const nextAdmin = vi.fn() as unknown as NextFunction;
    authorize('admin')(req, {} as Response, nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith();

    const nextOwner = vi.fn() as unknown as NextFunction;
    authorize('owner')(req, {} as Response, nextOwner);
    expect(nextOwner).toHaveBeenCalledWith(expect.any(AuthorizationError));
  });

  it('multiple roles ["member","admin"]: effective rank is the max (passes admin gate)', () => {
    const req = makeReq({ subjectType: 'user', userId: 'u', orgId: 'org', roles: ['member', 'admin'] });
    const next = vi.fn() as unknown as NextFunction;

    authorize('admin')(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('authorize() with no req.context -> 401 (AuthenticationError), not 500, not pass-through', () => {
    const req = makeReq(undefined);
    const next = vi.fn() as unknown as NextFunction;

    authorize('member')(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('is subject-agnostic: works unchanged for an agent_key context', () => {
    const req = makeReq({ subjectType: 'agent_key', agentKeyId: 'key-1', orgId: 'org', roles: ['admin'] });
    const next = vi.fn() as unknown as NextFunction;

    authorize('admin')(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });
});

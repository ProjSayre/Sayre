import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  resetConfigForTests,
  setConfigOverrideForTests,
} from '@sayre/config';
import { requireOrgId, tenantContext } from './tenantContext';

function makeReq(overrides: Partial<Request> = {}): Request {
  return { ...overrides } as Request;
}

afterEach(() => {
  resetConfigForTests();
});

describe('tenantContext', () => {
  it('stamps req.orgId from a server-side source (DEV_ORG_ID env var) and calls next()', () => {
    setConfigOverrideForTests('DEV_ORG_ID', 'org_env_configured');
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    tenantContext(req, {} as Response, next);

    expect(req.orgId).toBe('org_env_configured');
    expect(next).toHaveBeenCalledOnce();
  });

  it('falls back to the org_dev_local placeholder when DEV_ORG_ID is unset', () => {
    setConfigOverrideForTests('DEV_ORG_ID', undefined);
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    tenantContext(req, {} as Response, next);

    expect(req.orgId).toBe('org_dev_local');
  });

  it('never reads orgId from client-controlled input (query/body/headers) even if present', () => {
    setConfigOverrideForTests('DEV_ORG_ID', 'org_env_configured');
    // Simulate a request object that also happens to carry a client-supplied
    // orgId-shaped field on query/body/headers — tenantContext must ignore all
    // of it and only ever consult the server-side env var.
    const req = makeReq({
      query: { orgId: 'attacker-org' },
      body: { orgId: 'attacker-org' },
      headers: { 'x-org-id': 'attacker-org' },
    } as unknown as Partial<Request>);
    const next = vi.fn() as unknown as NextFunction;

    tenantContext(req, {} as Response, next);

    expect(req.orgId).toBe('org_env_configured');
    expect(req.orgId).not.toBe('attacker-org');
  });

  it('fails closed in production even when DEV_ORG_ID is configured', () => {
    setConfigOverrideForTests('NODE_ENV', 'production');
    setConfigOverrideForTests('DEV_ORG_ID', 'must-not-be-used');
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    tenantContext(req, {} as Response, next);

    expect(req.orgId).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('requireOrgId', () => {
  it('returns req.orgId when tenantContext has already run', () => {
    const req = makeReq({ orgId: 'org_dev_local' });
    expect(requireOrgId(req)).toBe('org_dev_local');
  });

  it('throws when req.orgId is unset (tenantContext did not run)', () => {
    const req = makeReq();
    expect(() => requireOrgId(req)).toThrow(/Missing tenant context/);
  });
});

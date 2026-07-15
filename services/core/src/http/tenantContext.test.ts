import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requireOrgId, tenantContext } from './tenantContext';

function makeReq(overrides: Partial<Request> = {}): Request {
  return { ...overrides } as Request;
}

const ORIGINAL_DEV_ORG_ID = process.env.DEV_ORG_ID;

afterEach(() => {
  if (ORIGINAL_DEV_ORG_ID === undefined) {
    delete process.env.DEV_ORG_ID;
  } else {
    process.env.DEV_ORG_ID = ORIGINAL_DEV_ORG_ID;
  }
});

describe('tenantContext', () => {
  it('stamps req.orgId from a server-side source (DEV_ORG_ID env var) and calls next()', () => {
    process.env.DEV_ORG_ID = 'org_env_configured';
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    tenantContext(req, {} as Response, next);

    expect(req.orgId).toBe('org_env_configured');
    expect(next).toHaveBeenCalledOnce();
  });

  it('falls back to the org_dev_local placeholder when DEV_ORG_ID is unset', () => {
    delete process.env.DEV_ORG_ID;
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;

    tenantContext(req, {} as Response, next);

    expect(req.orgId).toBe('org_dev_local');
  });

  it('never reads orgId from client-controlled input (query/body/headers) even if present', () => {
    process.env.DEV_ORG_ID = 'org_env_configured';
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

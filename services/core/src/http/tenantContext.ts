// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
//
// Placeholder tenant-resolution middleware. W1-03 owns real auth/tenant
// resolution; until then this stamps a single dev-only org id so downstream
// services/routes have something real to thread through.
//
// INVARIANT: org_id is resolved server-side and is NEVER read from
// req.query/req.body/headers a client controls (.claude/rules/security-multitenancy.md).

import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '@sayre/config';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgId?: string;
    }
  }
}

// TODO(W1-03): replace this placeholder with real auth-derived org resolution
// (session/JWT/API key -> org). Never source this value from client input.
export function tenantContext(req: Request, _res: Response, next: NextFunction): void {
  const environment = getConfig('NODE_ENV');
  if (environment !== 'development' && environment !== 'test') {
    next(new Error('Tenant context is unavailable until production authentication is configured.'));
    return;
  }
  req.orgId = getConfig('DEV_ORG_ID');
  next();
}

export function requireOrgId(req: Request): string {
  if (!req.orgId) {
    throw new Error('Missing tenant context: req.orgId was not set (tenantContext must run first)');
  }
  return req.orgId;
}

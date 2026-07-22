// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
// Coarse org-role gate over req.context (attached by authenticate()).
//
// Deliberately does NOT implement repo/branch/path/node-level RBAC — that is
// the Graph Query Service's job (W2-02); duplicating it here is banned by
// .claude/rules/security-multitenancy.md. Subject-agnostic: works unchanged
// for a future agent_key context (W4-06).

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OrgRole } from '../auth/context';
import { AuthenticationError } from './authenticate';

export class AuthorizationError extends Error {
  constructor(message = 'Insufficient role.') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

// owner > admin > member
const ROLE_RANK: Record<OrgRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

function maxRank(roles: OrgRole[]): number {
  return roles.reduce((max, role) => Math.max(max, ROLE_RANK[role]), 0);
}

export function authorize(minRole: OrgRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.context) {
      next(new AuthenticationError());
      return;
    }

    if (maxRank(req.context.roles) >= ROLE_RANK[minRole]) {
      next();
      return;
    }

    next(new AuthorizationError());
  };
}

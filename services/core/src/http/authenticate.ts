// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
// Reads the Authorization header and delegates verification to the service
// layer (services/authService.ts); attaches the resolved AuthContext to
// req.context and rejects (401) before any downstream service function runs
// when a credential is required and absent/invalid.
//
// INVARIANT: never reads orgId/userId/roles from query, body, or any header
// other than the signed bearer token (.claude/rules/security-multitenancy.md).

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getConfig } from '@sayre/config';
import type { UserAuthContext } from '../auth/context';
import { SessionTokenError } from '../auth/sessionToken';
import { devSessionContext, resolveSessionContext } from '../services/authService';

export class AuthenticationError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface AuthenticateDeps {
  resolve: (token: string) => Promise<UserAuthContext>;
}

const defaultDeps: AuthenticateDeps = {
  resolve: resolveSessionContext,
};

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

function extractBearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = BEARER_RE.exec(header.trim());
  return match?.[1];
}

function isDevOrTestEnvironment(): boolean {
  const environment = getConfig('NODE_ENV');
  return environment === 'development' || environment === 'test';
}

export function authenticate(deps?: Partial<AuthenticateDeps>): RequestHandler {
  const { resolve } = { ...defaultDeps, ...deps };

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = extractBearerToken(req.headers.authorization);

      if (token) {
        req.context = await resolve(token);
        next();
        return;
      }

      if (isDevOrTestEnvironment()) {
        req.context = devSessionContext();
        next();
        return;
      }

      next(new AuthenticationError());
    } catch (err) {
      if (err instanceof SessionTokenError) {
        next(new AuthenticationError());
        return;
      }
      // Any other failure (e.g. getSecret()/getConfig() throwing) is a server
      // misconfiguration, not a client 401 — propagate to the generic 500
      // fallback. Never leak the underlying message.
      next(err);
    }
  };
}

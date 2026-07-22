// Signed "install state" token — this is what keeps org_id server-controlled
// across the GitHub App install redirect round-trip: the org is signed at
// install-start (services/githubAppInstallService.ts#startGithubAppInstall)
// from the SERVER-RESOLVED org (req.orgId via tenantContext), and recovered
// at callback time (#handleGithubAppCallback) — never read from a client-
// supplied callback query param (.claude/rules/security-multitenancy.md).
//
// HS256, signed with env://JWT_SIGNING_KEY (W0-07 loader). 10-minute expiry:
// long enough to cover the GitHub-hosted installation UI, short enough that a
// leaked/replayed state token has a small blast radius.

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getSecret } from '@sayre/config';

export interface InstallState {
  org_id: string;
  nonce: string;
  purpose: 'github_app_install';
}

const PURPOSE = 'github_app_install' as const;
const EXPIRY = '10m';

export class InstallStateError extends Error {
  constructor(message = 'Invalid or expired GitHub App install state.') {
    super(message);
    this.name = 'InstallStateError';
  }
}

/** Signs a fresh install-state JWT binding this flow to `orgId`. Never accepts a client-supplied org. */
export async function signInstallState(orgId: string): Promise<string> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  const payload: InstallState = {
    org_id: orgId,
    nonce: randomUUID(),
    purpose: PURPOSE,
  };
  return jwt.sign(payload, key, { algorithm: 'HS256', expiresIn: EXPIRY });
}

/**
 * Verifies signature + expiry + `purpose` claim, returning the decoded state.
 * Throws `InstallStateError` for ANY failure (missing/malformed/tampered
 * signature, expired, wrong purpose, or a structurally invalid payload) — the
 * caller maps this uniformly to a 400, never leaking which specific check failed.
 */
export async function verifyInstallState(token: string): Promise<InstallState> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
  } catch {
    throw new InstallStateError();
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new InstallStateError();
  }
  const candidate = decoded as Record<string, unknown>;
  if (typeof candidate.org_id !== 'string' || candidate.org_id.length === 0) {
    throw new InstallStateError();
  }
  if (typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) {
    throw new InstallStateError();
  }
  if (candidate.purpose !== PURPOSE) {
    throw new InstallStateError();
  }

  return { org_id: candidate.org_id, nonce: candidate.nonce, purpose: PURPOSE };
}

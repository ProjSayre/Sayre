// Signed "Jira connect state" token — mirrors `github/installState.ts`
// exactly (HS256, `env://JWT_SIGNING_KEY`, 10-minute expiry, uniform error on
// ANY failure), with one addition: the Jira callback is UNAUTHENTICATED (no
// session survives the Atlassian consent redirect) and must still attribute
// the connection to a specific user, so this state ALSO carries the
// connecting user's id and an immutable label snapshot captured at connect-
// start — never re-derived from a client-supplied value at callback time.
//
// The `purpose: 'jira_oauth_connect'` claim is the ONLY thing preventing a
// `github_app_install` / `login_oauth` / `session` token (all signed with the
// SAME `JWT_SIGNING_KEY`) from being replayed here — verified explicitly,
// exactly as every sibling state module does.

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getSecret } from '@sayre/config';

export interface JiraConnectState {
  org_id: string;
  user_id: string;
  user_label: string;
  nonce: string;
  purpose: 'jira_oauth_connect';
}

const PURPOSE = 'jira_oauth_connect' as const;
const EXPIRY = '10m';

export class JiraConnectStateError extends Error {
  constructor(message = 'Invalid or expired Jira connect state.') {
    super(message);
    this.name = 'JiraConnectStateError';
  }
}

/** Signs a fresh connect-state JWT, binding this flow to the server-resolved org AND connecting user. */
export async function signJiraConnectState(input: {
  orgId: string;
  userId: string;
  userLabel: string;
}): Promise<string> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  const payload: JiraConnectState = {
    org_id: input.orgId,
    user_id: input.userId,
    user_label: input.userLabel,
    nonce: randomUUID(),
    purpose: PURPOSE,
  };
  return jwt.sign(payload, key, { algorithm: 'HS256', expiresIn: EXPIRY });
}

/**
 * Verifies signature + expiry + `purpose`, returning the decoded state.
 * Throws `JiraConnectStateError` for ANY failure (missing/malformed/tampered
 * signature, expired, wrong purpose, or a structurally invalid payload) — the
 * caller maps this uniformly to a 400, never leaking which check failed.
 */
export async function verifyJiraConnectState(
  token: string,
): Promise<JiraConnectState> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
  } catch {
    throw new JiraConnectStateError();
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new JiraConnectStateError();
  }
  const candidate = decoded as Record<string, unknown>;
  if (typeof candidate.org_id !== 'string' || candidate.org_id.length === 0) {
    throw new JiraConnectStateError();
  }
  if (typeof candidate.user_id !== 'string' || candidate.user_id.length === 0) {
    throw new JiraConnectStateError();
  }
  if (typeof candidate.user_label !== 'string' || candidate.user_label.length === 0) {
    throw new JiraConnectStateError();
  }
  if (typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) {
    throw new JiraConnectStateError();
  }
  if (candidate.purpose !== PURPOSE) {
    throw new JiraConnectStateError();
  }

  return {
    org_id: candidate.org_id,
    user_id: candidate.user_id,
    user_label: candidate.user_label,
    nonce: candidate.nonce,
    purpose: PURPOSE,
  };
}

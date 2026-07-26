// Signed "login state" token — this is the CSRF-integrity anchor for the
// real "Sign in with GitHub" OAuth round-trip (AUTH-01). Structural copy of
// src/github/installState.ts, but this family carries NO org_id (there is no
// tenant yet — org is resolved or created AFTER the callback verifies this
// token and the code exchange completes), an optional validated
// `redirect_to`, and `purpose: 'login_oauth'`.
//
// HS256, signed with env://JWT_SIGNING_KEY (W0-07 loader) — the SAME signing
// key as installState.ts and sessionToken.ts. The `purpose` claim is the ONLY
// thing keeping these three token families mutually non-cross-usable; see
// verifyLoginState below and .claude/rules/security-multitenancy.md.
//
// 10-minute expiry: long enough to cover the GitHub-hosted authorize UI,
// short enough that a leaked/replayed state token has a small blast radius.
// Stateless (no nonce store) — identical posture to installState.ts: a
// replayed, still-valid, unexpired login-state passes verification here, but
// the paired authorization `code` is single-use, so replay is bounded by
// GitHub rejecting the code at exchange (see loginService.ts).

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getSecret } from '@sayre/config';

export interface LoginState {
  nonce: string;
  purpose: 'login_oauth';
  redirect_to?: string; // present only if a validated safe relative path was supplied at start
}

const PURPOSE = 'login_oauth' as const;
const EXPIRY = '10m';

export class LoginStateError extends Error {
  constructor(message = 'Invalid or expired login state.') {
    super(message);
    this.name = 'LoginStateError';
  }
}

/** True iff `code` is an ASCII whitespace or control character code point (<= space, or DEL). */
function isWhitespaceOrControlCode(code: number): boolean {
  return code <= 32 || code === 127;
}

function hasWhitespaceOrControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (isWhitespaceOrControlCode(value.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * True iff `value` is a same-origin relative path: starts with a single '/',
 * is not '//' or '/\' (protocol-relative / backslash tricks browsers may
 * still treat as a host boundary), carries no scheme (':'), and has no
 * whitespace/control characters. Used to keep `redirect_to` from becoming an
 * open-redirect or a token-exfiltration vector (the token rides the same
 * fragment — see loginService.ts's LoginCallbackResult.redirectTo).
 */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false;
  if (value.includes(':')) return false;
  if (value.includes('\\')) return false;
  if (hasWhitespaceOrControlChar(value)) return false;
  return true;
}

/**
 * Signs a fresh login-state JWT. NEVER carries an org — org is resolved or
 * created only after this token is verified and the code exchange succeeds.
 * If `input.redirectTo` is present it MUST pass `isSafeRelativePath`, else it
 * is silently dropped (not signed) rather than rejecting the whole start.
 */
export async function signLoginState(input?: { redirectTo?: string }): Promise<string> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  const payload: LoginState = {
    nonce: randomUUID(),
    purpose: PURPOSE,
  };
  if (input?.redirectTo !== undefined && isSafeRelativePath(input.redirectTo)) {
    payload.redirect_to = input.redirectTo;
  }
  return jwt.sign(payload, key, { algorithm: 'HS256', expiresIn: EXPIRY });
}

/**
 * Verifies signature + expiry + `purpose === 'login_oauth'` + structural
 * validity. Throws `LoginStateError` for ANY failure (missing/malformed/
 * tampered signature, expired, wrong purpose, or a structurally invalid
 * payload) — the caller maps this uniformly to a 400, never leaking which
 * specific check failed. `redirect_to`, if present, is re-validated with
 * `isSafeRelativePath` and silently dropped (not the whole verification) if
 * it no longer passes.
 */
export async function verifyLoginState(token: string): Promise<LoginState> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
  } catch {
    throw new LoginStateError();
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new LoginStateError();
  }
  const candidate = decoded as Record<string, unknown>;
  if (typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) {
    throw new LoginStateError();
  }
  // The ONLY guard preventing a `session` or `github_app_install` token from
  // being replayed as login state (or vice versa) — all three families share
  // JWT_SIGNING_KEY.
  if (candidate.purpose !== PURPOSE) {
    throw new LoginStateError();
  }

  const state: LoginState = { nonce: candidate.nonce, purpose: PURPOSE };
  if (
    typeof candidate.redirect_to === 'string' &&
    isSafeRelativePath(candidate.redirect_to)
  ) {
    state.redirect_to = candidate.redirect_to;
  }
  return state;
}

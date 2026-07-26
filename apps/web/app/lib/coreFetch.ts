// Shared fetch wrapper for calls to the core API: attaches the bearer session
// token issued by the real "Sign in with GitHub" flow (AUTH-01,
// app/auth/complete/page.tsx) to every request, when one is stored.
//
// SSR-safe: every storage helper checks for `window` before touching it, so
// this module is safe to import from server components / during SSR (no
// throw, `getStoredSessionToken()` just returns null).

export const SESSION_TOKEN_STORAGE_KEY = 'sayre.session.token';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

/** Returns the stored session token, or null when there is no `window` or none is set. */
export function getStoredSessionToken(): string | null {
  if (!hasWindow()) return null;
  try {
    return window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    // Storage can throw (privacy mode, disabled storage, etc.) — treat as "no token".
    return null;
  }
}

/** Stores the session token. No-op (does not throw) when there is no `window`. */
export function setStoredSessionToken(token: string): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage failures — the session simply won't persist across reloads.
  }
}

/** Clears the stored session token. No-op (does not throw) when there is no `window`. */
export function clearStoredSessionToken(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * `fetch` wrapper: when a session token is stored, merges
 * `Authorization: Bearer <token>` into the request headers WITHOUT clobbering
 * any caller-supplied header (including a caller-supplied `Authorization`,
 * which wins). Defaults `credentials` to `'same-origin'` when the caller
 * didn't specify one.
 */
export function coreFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getStoredSessionToken();
  const headers = new Headers(init.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, {
    credentials: 'same-origin',
    ...init,
    headers,
  });
}

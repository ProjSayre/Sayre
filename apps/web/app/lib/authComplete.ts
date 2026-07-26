// Pure hash-parsing helper for the AUTH-01 login completion page
// (app/auth/complete/page.tsx). Kept separate from the page component so the
// parsing logic — including the open-redirect guard on `redirect_to` — is
// unit-testable without a DOM/router.

export interface AuthCompleteParams {
  token: string | null;
  redirectTo: string;
}

const DEFAULT_REDIRECT_TO = '/';

/**
 * Same same-origin-relative-path rule as core's
 * `src/auth/loginState.ts::isSafeRelativePath` — starts with a single '/',
 * not '//' or '/\', no scheme (':'), no backslash, no whitespace/control
 * characters. Duplicated here (not imported) because this package has no
 * dependency on services/core.
 */
function isSafeRelativePath(value: string): boolean {
  if (value.length === 0) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false;
  if (value.includes(':')) return false;
  if (value.includes('\\')) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) return false;
  }
  return true;
}

/**
 * Parses `location.hash` (e.g. `'#token=...&redirect_to=...'`). `redirectTo`
 * defaults to `'/'` and is forced back to `'/'` unless the supplied value is
 * a safe same-origin relative path — this is the second of the two
 * open-redirect / token-exfiltration guards (the first is at sign-time in
 * core's `signLoginState`).
 */
export function parseAuthCompleteHash(hash: string): AuthCompleteParams {
  const withoutLeadingHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(withoutLeadingHash);

  const token = params.get('token');
  const rawRedirectTo = params.get('redirect_to');
  const redirectTo =
    rawRedirectTo !== null && isSafeRelativePath(rawRedirectTo) ? rawRedirectTo : DEFAULT_REDIRECT_TO;

  return { token, redirectTo };
}

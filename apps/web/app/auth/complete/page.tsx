'use client';

// AUTH-01 login completion page. Core's GET /auth/github/callback redirects
// the browser here with the session token in the URL FRAGMENT
// (`#token=...[&redirect_to=...]`), never a query string, specifically so it
// never reaches the server (no access-log/Referer leak — see
// services/core/src/services/loginService.ts). This page reads
// `window.location.hash`, stores the token, strips the fragment from
// history so the token doesn't linger there, then navigates on.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { parseAuthCompleteHash } from '../../lib/authComplete';
import {
  getStoredSessionToken,
  persistSessionCookie,
  setStoredSessionToken,
} from '../../lib/coreFetch';

export default function AuthCompletePage() {
  const router = useRouter();

  useEffect(() => {
    const { token: hashToken, redirectTo } = parseAuthCompleteHash(window.location.hash);

    // React Strict Mode (dev-only) double-invokes this effect. The first
    // invocation already stores the token and strips the fragment via
    // history.replaceState -- which Next.js's router treats as a navigation
    // and re-triggers this effect against the now-fragment-less URL. Fall
    // back to whatever's already stored so the second invocation doesn't
    // misreport "no token" and bounce to /login.
    const token = hashToken ?? getStoredSessionToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    let active = true;
    setStoredSessionToken(token);
    // Strip the fragment from history immediately — the token must not
    // linger in browser history once it has been read and stored.
    if (hashToken) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    // A full-page GitHub App installation cannot attach a localStorage bearer
    // header. Mirror the same token into an HttpOnly BFF cookie before leaving
    // this completion page; core still verifies it on every request.
    void persistSessionCookie()
      .catch(() => undefined)
      .finally(() => {
        if (active) router.replace(redirectTo);
      });
    return () => {
      active = false;
    };
    // Runs once on mount: the redirect fully replaces this page's history
    // entry, so there is no scenario where hash/router change underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="auth-page">
      <p>Signing you in&hellip;</p>
    </main>
  );
}

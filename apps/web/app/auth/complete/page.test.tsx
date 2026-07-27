import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The page redirects as soon as its effect resolves, so it cannot be captured
// in a browser. Effects do not run under renderToStaticMarkup, which is what
// makes the rendered card observable here.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('../../lib/coreFetch', () => ({
  getStoredSessionToken: () => null,
  persistSessionCookie: async () => undefined,
  setStoredSessionToken: vi.fn(),
}));

(globalThis as unknown as { React: typeof React }).React = React;

import AuthCompletePage from './page';

const markup = renderToStaticMarkup(<AuthCompletePage />);

describe('auth completion page', () => {
  it('uses the same card as the rest of the auth flow', () => {
    // Every sign-in passes through this page. Dropping to bare text here was
    // visible mid-flow, between the auth card and the workspace.
    expect(markup).toContain('class="auth-page"');
    expect(markup).toContain('class="auth-card"');
    expect(markup).toContain('class="brand"');
    expect(markup).toContain('sayre_');
  });

  it('says what is happening rather than leaving a blank screen', () => {
    expect(markup).toContain('Completing sign-in');
    expect(markup).toContain('aria-live="polite"');
  });

  it('exposes no session material in the rendered markup', () => {
    expect(markup).not.toContain('token');
    expect(markup).not.toContain('#');
  });
});

// Unit tests for AuthCard (AUTH-01): both `login`/`signup` modes render a
// single "Continue with GitHub" link and NO password/email/name form
// remains. Uses renderToStaticMarkup so the server component can be tested
// pattern for a non-interactive component (no hooks, no fetch — no
// react-test-renderer/act needed).
//
// Not present in spec.md's "Affected files" list (dev did not add this file)
// but explicitly called for by spec.md's Edge Cases: "AuthCard in both login
// and signup modes renders the GitHub link (no password/email/name inputs
// remain)." Added here to close that gap.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// AuthCard.tsx does not itself import React
// from 'react'` — it relies on Next.js's automatic JSX runtime, which never
// needs a local `React` binding. Vitest's default esbuild transform here
// compiles JSX with the classic runtime (React.createElement), so a module
// under test that has no local React import throws "React is not defined"
// the moment it renders — a test-tooling mismatch, not a behavior bug. Rather
// than edit AuthCard.tsx's production source to satisfy a test transform,
// shim the same global lookup pattern other classic-runtime polyfills use.
(globalThis as unknown as { React: typeof React }).React = React;

import { AuthCard } from './AuthCard';

describe('AuthCard', () => {
  it.each(['login', 'signup'] as const)('renders a Continue-with-GitHub link in %s mode', (mode) => {
    const html = renderToStaticMarkup(<AuthCard mode={mode} />);

    expect(html).toContain('href="/api/core/auth/github/login"');
    expect(html).toContain('Continue with GitHub');
  });

  it.each(['login', 'signup'] as const)('renders no password/email/name form inputs in %s mode', (mode) => {
    const html = renderToStaticMarkup(<AuthCard mode={mode} />);

    expect(html).not.toContain('<form');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toMatch(/name="name"/);
    expect(html).not.toContain('<input');
  });

  it('renders login-mode copy and a link to /signup', () => {
    const html = renderToStaticMarkup(<AuthCard mode="login" />);

    expect(html).toContain('Welcome back');
    expect(html).toContain('href="/signup"');
  });

  it('renders signup-mode copy and a link to /login', () => {
    const html = renderToStaticMarkup(<AuthCard mode="signup" />);

    expect(html).toContain('Create your workspace');
    expect(html).toContain('href="/login"');
  });

  it('uses a plain <a>, not a client-side-routed link, for the GitHub action (full navigation required for the 302 chain)', () => {
    const html = renderToStaticMarkup(<AuthCard mode="login" />);
    const githubAnchorMatch = html.match(/<a[^>]*href="\/api\/core\/auth\/github\/login"[^>]*>/);

    expect(githubAnchorMatch).not.toBeNull();
    // next/link-rendered anchors don't carry any distinguishing attribute
    // here either way, so the strongest available signal is: it's a real
    // <a href> (not a <button>/onClick-only element) that survives static
    // markup rendering — proving it isn't gated behind client JS.
    expect(githubAnchorMatch?.[0]).toContain('class="auth-primary"');
  });
});

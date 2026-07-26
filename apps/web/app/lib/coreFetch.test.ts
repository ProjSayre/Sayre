// Unit tests for the shared core-API fetch wrapper: attaches the Authorization
// header when a session token is stored, omits it when absent, never
// clobbers a caller-supplied header, and is safe to call during SSR (no
// `window`). Runs under vitest's node environment (see vitest.config.ts) —
// there is no real `window` unless we stub one, which doubles as the SSR
// no-window coverage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_TOKEN_STORAGE_KEY,
  clearStoredSessionToken,
  coreFetch,
  getStoredSessionToken,
  setStoredSessionToken,
} from './coreFetch';

function makeFakeWindow() {
  const store = new Map<string, string>();
  return {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
}

describe('storage helpers — no window (SSR)', () => {
  it('getStoredSessionToken returns null when there is no window', () => {
    expect(typeof window).toBe('undefined');
    expect(getStoredSessionToken()).toBeNull();
  });

  it('setStoredSessionToken does not throw when there is no window', () => {
    expect(() => setStoredSessionToken('token')).not.toThrow();
  });

  it('clearStoredSessionToken does not throw when there is no window', () => {
    expect(() => clearStoredSessionToken()).not.toThrow();
  });

  it('coreFetch does not throw and sends no Authorization header when there is no window', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    await coreFetch('/api/core/whatever');
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init!.headers);
    expect(headers.has('Authorization')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('storage helpers — with window', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = makeFakeWindow();
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.unstubAllGlobals();
  });

  it('round-trips a stored token', () => {
    setStoredSessionToken('abc123');
    expect(getStoredSessionToken()).toBe('abc123');
  });

  it('clears a stored token', () => {
    setStoredSessionToken('abc123');
    clearStoredSessionToken();
    expect(getStoredSessionToken()).toBeNull();
  });

  it('getStoredSessionToken returns null when nothing is stored', () => {
    expect(getStoredSessionToken()).toBeNull();
  });

  it('stores under the documented storage key', () => {
    setStoredSessionToken('abc123');
    expect(window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY)).toBe('abc123');
  });
});

describe('coreFetch — with window / stored token', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = makeFakeWindow();
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.unstubAllGlobals();
  });

  it('attaches Authorization: Bearer <token> when a token is stored', async () => {
    setStoredSessionToken('my-session-token');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);

    await coreFetch('/api/core/repos/1/technical-tree');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/core/repos/1/technical-tree');
    const headers = new Headers(init!.headers);
    expect(headers.get('Authorization')).toBe('Bearer my-session-token');
  });

  it('omits Authorization when no token is stored', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);

    await coreFetch('/api/core/repos/1/technical-tree');

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init!.headers);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('preserves caller-supplied headers alongside the attached Authorization header', async () => {
    setStoredSessionToken('my-session-token');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);

    await coreFetch('/api/core/x', { headers: { accept: 'application/json' } });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init!.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer my-session-token');
  });

  it('does not clobber a caller-supplied Authorization header', async () => {
    setStoredSessionToken('stored-token');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);

    await coreFetch('/api/core/x', { headers: { Authorization: 'Bearer caller-supplied' } });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init!.headers);
    expect(headers.get('Authorization')).toBe('Bearer caller-supplied');
  });

  it('defaults credentials to same-origin', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);

    await coreFetch('/api/core/x');

    const [, init] = fetchMock.mock.calls[0];
    expect(init!.credentials).toBe('same-origin');
  });

  it('lets the caller override credentials', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);

    await coreFetch('/api/core/x', { credentials: 'include' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init!.credentials).toBe('include');
  });
});

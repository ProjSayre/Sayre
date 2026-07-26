import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE, POST } from './route';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('browser session cookie adapter', () => {
  it('accepts only a bounded bearer credential and writes an HttpOnly cookie', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = POST(
      new NextRequest('https://sayre.example/api/session', {
        method: 'POST',
        headers: { authorization: 'Bearer signed-session' },
      }),
    );

    expect(response.status).toBe(204);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('sayre_session=signed-session');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it('rejects absent, malformed, or oversized credentials', () => {
    const request = (authorization?: string) =>
      new NextRequest('http://web.local/api/session', {
        method: 'POST',
        headers: authorization === undefined ? {} : { authorization },
      });

    expect(POST(request()).status).toBe(401);
    expect(POST(request('Basic value')).status).toBe(401);
    expect(POST(request(`Bearer ${'x'.repeat(8193)}`)).status).toBe(401);
  });

  it('expires the same cookie on sign out', () => {
    const response = DELETE();
    const cookie = response.headers.get('set-cookie') ?? '';

    expect(response.status).toBe(204);
    expect(cookie).toContain('sayre_session=');
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});

// Unit tests for the default GithubOAuthClient implementation. Mocks global
// `fetch` — no real network access, no GitHub API calls. Covers the code
// exchange (success, bad_verification_code, network 5xx), GET /user, and the
// null-email fallback to GET /user/emails (primary+verified / first-verified
// / none-verified).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import {
  createDefaultGithubOAuthClient,
  GithubOAuthApiError,
  GithubOAuthCodeError,
  NoVerifiedEmailError,
} from './oauthClient';

beforeEach(() => {
  setConfigOverrideForTests('GITHUB_WEB_BASE_URL', 'https://github.test');
  setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
  setConfigOverrideForTests('GITHUB_APP_CLIENT_ID', 'client-id-123');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://GITHUB_APP_CLIENT_SECRET') return 'test-client-secret';
    throw new Error(`unexpected secret ref: ${ref}`);
  });
});

afterEach(() => {
  resetConfigForTests();
  resetSecretsForTests();
  vi.unstubAllGlobals();
});

describe('exchangeCodeForToken', () => {
  it('resolves the access token on a successful exchange', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ access_token: 'gho_faketoken', token_type: 'bearer' })),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.exchangeCodeForToken('good-code')).resolves.toBe('gho_faketoken');
  });

  it('sends client_id/client_secret/code in the body to the WEB base URL', async () => {
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'gho_faketoken' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createDefaultGithubOAuthClient();
    await client.exchangeCodeForToken('the-code');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://github.test/login/oauth/access_token');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      client_id: 'client-id-123',
      client_secret: 'test-client-secret',
      code: 'the-code',
    });
  });

  it('throws GithubOAuthCodeError on a 200-with-error body (bad_verification_code)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'bad_verification_code', error_description: 'x' })),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.exchangeCodeForToken('reused-code')).rejects.toBeInstanceOf(
      GithubOAuthCodeError,
    );
  });

  it('throws GithubOAuthCodeError on a 200 body missing access_token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const client = createDefaultGithubOAuthClient();
    await expect(client.exchangeCodeForToken('weird-code')).rejects.toBeInstanceOf(
      GithubOAuthCodeError,
    );
  });

  it('throws GithubOAuthApiError on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.exchangeCodeForToken('any-code')).rejects.toBeInstanceOf(
      GithubOAuthApiError,
    );
  });

  it('throws GithubOAuthApiError on a non-2xx (GitHub 5xx) response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const client = createDefaultGithubOAuthClient();
    await expect(client.exchangeCodeForToken('any-code')).rejects.toBeInstanceOf(
      GithubOAuthApiError,
    );
  });

  it('never logs the code, client secret, or access token', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ access_token: 'gho_secret_should_not_leak' })),
    );
    const client = createDefaultGithubOAuthClient();
    await client.exchangeCodeForToken('secret-code-should-not-leak');
    const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat();
    expect(allCalls.join(' ')).not.toContain('gho_secret_should_not_leak');
    expect(allCalls.join(' ')).not.toContain('secret-code-should-not-leak');
    expect(allCalls.join(' ')).not.toContain('test-client-secret');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('getAuthenticatedUser', () => {
  it('maps GET /user, coercing numeric id to string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ id: 42, login: 'octocat', name: 'The Octocat', email: 'octo@example.com' }),
      ),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.getAuthenticatedUser('token')).resolves.toEqual({
      id: '42',
      login: 'octocat',
      name: 'The Octocat',
      email: 'octo@example.com',
    });
  });

  it('passes email:null through unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 1, login: 'private-user', name: null, email: null })),
    );
    const client = createDefaultGithubOAuthClient();
    const user = await client.getAuthenticatedUser('token');
    expect(user.email).toBeNull();
    expect(user.name).toBeNull();
  });

  it('sends the bearer token and API version headers to the API base URL', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: 1, login: 'octocat', name: null, email: null }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createDefaultGithubOAuthClient();
    await client.getAuthenticatedUser('my-token');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.test/user');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-token');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('throws GithubOAuthApiError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const client = createDefaultGithubOAuthClient();
    await expect(client.getAuthenticatedUser('bad-token')).rejects.toBeInstanceOf(
      GithubOAuthApiError,
    );
  });

  it('throws GithubOAuthApiError on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.getAuthenticatedUser('token')).rejects.toBeInstanceOf(GithubOAuthApiError);
  });
});

describe('getPrimaryVerifiedEmail', () => {
  it('picks the primary+verified email when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'primary@example.com', primary: true, verified: true },
        ]),
      ),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.getPrimaryVerifiedEmail('token')).resolves.toBe('primary@example.com');
  });

  it('falls back to the first verified email when no primary+verified exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          { email: 'unverified@example.com', primary: true, verified: false },
          { email: 'verified@example.com', primary: false, verified: true },
        ]),
      ),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.getPrimaryVerifiedEmail('token')).resolves.toBe('verified@example.com');
  });

  it('throws NoVerifiedEmailError when no email is verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([{ email: 'unverified@example.com', primary: true, verified: false }]),
      ),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.getPrimaryVerifiedEmail('token')).rejects.toBeInstanceOf(
      NoVerifiedEmailError,
    );
  });

  it('throws NoVerifiedEmailError on an empty email list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    const client = createDefaultGithubOAuthClient();
    await expect(client.getPrimaryVerifiedEmail('token')).rejects.toBeInstanceOf(
      NoVerifiedEmailError,
    );
  });

  it('throws GithubOAuthApiError on transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const client = createDefaultGithubOAuthClient();
    await expect(client.getPrimaryVerifiedEmail('token')).rejects.toBeInstanceOf(
      GithubOAuthApiError,
    );
  });
});

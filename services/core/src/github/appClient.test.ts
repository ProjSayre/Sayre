// Unit tests for the default GithubAppClient implementation. Mocks global
// `fetch` — no real network access, no GitHub API calls. Not explicitly
// listed in spec.md's test file list, but added since this module handles
// GitHub App credentials (.claude/rules/security-multitenancy.md) and is
// otherwise only exercised indirectly (via an injected fake) by
// githubAppInstallService.test.ts.

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import { createDefaultGithubAppClient, GithubAppApiError } from './appClient';

// A real (but test-only, freshly generated, never used anywhere else) RSA
// keypair — RS256 signing needs a structurally valid PEM, not a fixed string.
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

beforeEach(() => {
  setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
  setConfigOverrideForTests('GITHUB_APP_ID', '12345');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://GITHUB_APP_PRIVATE_KEY') return PRIVATE_KEY;
    throw new Error(`unexpected secret ref: ${ref}`);
  });
});

afterEach(() => {
  resetConfigForTests();
  resetSecretsForTests();
  vi.unstubAllGlobals();
});

describe('createDefaultGithubAppClient', () => {
  it('mintInstallationToken wraps a network failure as GithubAppApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const client = createDefaultGithubAppClient();
    await expect(client.mintInstallationToken(1)).rejects.toBeInstanceOf(GithubAppApiError);
  });

  it('mintInstallationToken wraps a non-2xx response as GithubAppApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const client = createDefaultGithubAppClient();
    await expect(client.mintInstallationToken(1)).rejects.toBeInstanceOf(GithubAppApiError);
  });

  it('mintInstallationToken resolves the token from a 2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ token: 'ghs_faketoken' })),
    );
    const client = createDefaultGithubAppClient();
    await expect(client.mintInstallationToken(1)).resolves.toBe('ghs_faketoken');
  });

  it('listInstallationRepos mints a token then paginates /installation/repositories', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/access_tokens')) {
          return Response.json({ token: 'ghs_faketoken' });
        }
        // NOTE: match on the actual `page` query param, not `url.includes('page=1')` —
        // `per_page=100` itself contains the substring "page=1", which would
        // spuriously match every page and pagination would never terminate.
        const page = new URL(url).searchParams.get('page');
        if (page === '1') {
          return Response.json({
            repositories: Array.from({ length: 100 }, (_, i) => ({
              id: i,
              full_name: `acme/repo-${i}`,
              default_branch: 'main',
            })),
          });
        }
        return Response.json({
          repositories: [{ id: 999, full_name: 'acme/repo-999', default_branch: 'main' }],
        });
      }),
    );
    const client = createDefaultGithubAppClient();
    const repos = await client.listInstallationRepos(1);
    expect(repos).toHaveLength(101);
    expect(repos[0]).toEqual({ provider_repo_id: '0', full_name: 'acme/repo-0', default_branch: 'main' });
    expect(calls.some((u) => new URL(u).searchParams.get('page') === '2')).toBe(true);
    expect(calls).toHaveLength(3); // mint + page 1 + page 2 (terminates, does not keep paginating)
  });

  it('listInstallationRepos maps a null default_branch through unchanged (empty repo)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        return Response.json({
          repositories: [{ id: 1, full_name: 'acme/empty', default_branch: null }],
        });
      }),
    );
    const client = createDefaultGithubAppClient();
    const repos = await client.listInstallationRepos(1);
    expect(repos).toEqual([{ provider_repo_id: '1', full_name: 'acme/empty', default_branch: null }]);
  });

  it('listInstallationRepos wraps a repo-list failure (after a successful mint) as GithubAppApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        return new Response(null, { status: 500 });
      }),
    );
    const client = createDefaultGithubAppClient();
    await expect(client.listInstallationRepos(1)).rejects.toBeInstanceOf(GithubAppApiError);
  });

  it('never logs the minted token or private key', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ token: 'ghs_secret_should_not_leak' })),
    );
    const client = createDefaultGithubAppClient();
    await client.mintInstallationToken(1);
    const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat();
    expect(allCalls.join(' ')).not.toContain('ghs_secret_should_not_leak');
    expect(allCalls.join(' ')).not.toContain(PRIVATE_KEY);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

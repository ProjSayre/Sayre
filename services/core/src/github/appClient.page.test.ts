// Leading-red tests (W7-01) for the paginated discovery API that replaces
// listInstallationRepos(installationId, maxRepos?): listInstallationReposPage(installationId,
// page, perPage?). Mirrors appClient.test.ts's conventions (mocked global fetch, config/secret
// overrides, RS256 test keypair) — see spec.md "Interfaces / signatures" ->
// services/core/src/github/appClient.ts, and Approach step 1.
//
// `listInstallationReposPage` does not exist on the current GithubAppClient shape yet, so every
// test below fails today with "listInstallationReposPage is not a function" (RED-CORRECT: a
// missing function, per .sdd/stages/red.md step 4).

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import { createDefaultGithubAppClient, GithubAppApiError } from './appClient';

const SHA_A = 'a'.repeat(40);

const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

beforeEach(() => {
  setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
  setConfigOverrideForTests('GITHUB_WEB_BASE_URL', 'https://github.test');
  setConfigOverrideForTests('GITHUB_APP_ID', '12345');
  setConfigOverrideForTests('GITHUB_APP_CLIENT_ID', 'Iv1.test-client');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://GITHUB_APP_PRIVATE_KEY') return PRIVATE_KEY;
    if (ref === 'env://GITHUB_APP_CLIENT_SECRET') return 'test-client-secret';
    throw new Error(`unexpected secret ref: ${ref}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetConfigForTests();
  resetSecretsForTests();
  vi.unstubAllGlobals();
});

function fetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(handler);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('listInstallationReposPage — AC-3 (one page, exact request shape, hasNextPage)', () => {
  // @spec AC-3
  it('fetches exactly one page at the default per_page (100) and reports hasNextPage=true for a full page', async () => {
    const calls: string[] = [];
    fetchMock((url) => {
      calls.push(url);
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      if (url.includes('/git/ref/')) return Response.json({ object: { sha: SHA_A } });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/installation/repositories');
      expect(parsed.searchParams.get('per_page')).toBe('100');
      expect(parsed.searchParams.get('page')).toBe('1');
      return Response.json({
        total_count: 137,
        repositories: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          full_name: `acme/repo-${i}`,
          default_branch: 'main',
        })),
      });
    });

    const client = createDefaultGithubAppClient();
    const page = await client.listInstallationReposPage(1, 1);

    expect(page.page).toBe(1);
    expect(page.hasNextPage).toBe(true);
    expect(page.totalCount).toBe(137);
    expect(page.repos).toHaveLength(100);
    expect(page.repos[0]).toEqual({
      provider_repo_id: '0',
      full_name: 'acme/repo-0',
      default_branch: 'main',
      default_branch_head_sha: SHA_A,
    });
    const listCalls = calls.filter((url) => url.includes('/installation/repositories'));
    expect(listCalls).toHaveLength(1); // exactly one page request, no accumulation loop
  });

  // @spec AC-3
  it('reports hasNextPage=false for a short (non-full) page and honours a custom perPage/page', async () => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      if (url.includes('/git/ref/')) return Response.json({ object: { sha: SHA_A } });
      const parsed = new URL(url);
      expect(parsed.searchParams.get('per_page')).toBe('20');
      expect(parsed.searchParams.get('page')).toBe('2');
      return Response.json({
        // Deliberately fewer than the requested per_page (20) -- a SHORT page, which is what
        // makes hasNextPage false under AC-3's own "hasNextPage iff repos.length === perPage"
        // definition. (Fixed from an earlier draft that returned exactly 20 items here, which
        // is a FULL page for per_page=20 and cannot demonstrate a short page at all.)
        repositories: Array.from({ length: 7 }, (_, i) => ({
          id: i,
          full_name: `acme/repo-${i}`,
          default_branch: 'main',
        })),
      });
    });

    const page = await createDefaultGithubAppClient().listInstallationReposPage(1, 2, 20);
    expect(page.hasNextPage).toBe(false);
    expect(page.repos).toHaveLength(7);
  });
});

describe('listInstallationReposPage — EC-13 (total_count defensive parsing)', () => {
  // @spec EC-13
  it.each([
    ['absent', undefined],
    ['negative', -5],
    ['non-integer', 12.5],
    ['absurdly large', Number.MAX_SAFE_INTEGER * 2],
    ['non-numeric', 'a lot' as unknown as number],
  ])('stores total_count as null when %s', async (_label, rawTotalCount) => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      const body: Record<string, unknown> = { repositories: [] };
      if (rawTotalCount !== undefined) body.total_count = rawTotalCount;
      return Response.json(body);
    });

    const page = await createDefaultGithubAppClient().listInstallationReposPage(1, 1);
    expect(page.totalCount).toBeNull();
  });
});

describe('listInstallationReposPage — EC-12 (malformed page response)', () => {
  // @spec EC-12
  it('rejects with GithubAppApiError when `repositories` is missing/non-array', async () => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      return Response.json({ repositories: 'not-an-array' });
    });
    await expect(createDefaultGithubAppClient().listInstallationReposPage(1, 1)).rejects.toBeInstanceOf(
      GithubAppApiError,
    );
  });

  // @spec EC-12
  it('rejects with GithubAppApiError on a malformed full_name', async () => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      return Response.json({
        repositories: [{ id: 1, full_name: 'not-owner-slash-name', default_branch: 'main' }],
      });
    });
    await expect(createDefaultGithubAppClient().listInstallationReposPage(1, 1)).rejects.toBeInstanceOf(
      GithubAppApiError,
    );
  });

  // @spec EC-12
  it('rejects with GithubAppApiError on a blank default branch', async () => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      return Response.json({
        repositories: [{ id: 1, full_name: 'acme/widgets', default_branch: '   ' }],
      });
    });
    await expect(createDefaultGithubAppClient().listInstallationReposPage(1, 1)).rejects.toBeInstanceOf(
      GithubAppApiError,
    );
  });

  // @spec EC-12
  it('rejects with GithubAppApiError on a non-hex default-branch HEAD sha', async () => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      if (url.includes('/git/ref/')) return Response.json({ object: { sha: 'not-hex-zzzz' } });
      return Response.json({
        repositories: [{ id: 1, full_name: 'acme/widgets', default_branch: 'main' }],
      });
    });
    await expect(createDefaultGithubAppClient().listInstallationReposPage(1, 1)).rejects.toBeInstanceOf(
      GithubAppApiError,
    );
  });

  // @spec EC-12
  it('rejects with GithubAppApiError on an oversized response body (Content-Length over budget)', async () => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      const body = JSON.stringify({ repositories: [] });
      return new Response(body, {
        headers: { 'content-length': String(300 * 1024), 'content-type': 'application/json' },
      });
    });
    await expect(createDefaultGithubAppClient().listInstallationReposPage(1, 1)).rejects.toBeInstanceOf(
      GithubAppApiError,
    );
  });

  // @spec EC-12
  it('rejects with GithubAppApiError on a bad (non-integer/negative) Content-Length', async () => {
    fetchMock((url) => {
      if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
      return new Response(JSON.stringify({ repositories: [] }), {
        headers: { 'content-length': '-4', 'content-type': 'application/json' },
      });
    });
    await expect(createDefaultGithubAppClient().listInstallationReposPage(1, 1)).rejects.toBeInstanceOf(
      GithubAppApiError,
    );
  });
});

describe('listInstallationReposPage — EC-15 (invalid page/perPage arguments)', () => {
  // @spec EC-15
  it.each([
    ['page < 1', 0, undefined],
    ['page non-integer', 1.5, undefined],
    ['perPage 0', 1, 0],
    ['perPage negative', 1, -1],
    ['perPage > 100', 1, 101],
    ['perPage non-integer', 1, 12.3],
  ])('throws GithubAppApiError for %s before any network call or token mint', async (_label, page, perPage) => {
    const fetchSpy = fetchMock(() => {
      throw new Error('fetch must not be called for invalid arguments');
    });

    await expect(
      createDefaultGithubAppClient().listInstallationReposPage(1, page, perPage),
    ).rejects.toBeInstanceOf(GithubAppApiError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

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
import {
  createDefaultGithubAppClient,
  GithubAppApiError,
  GithubAppAuthorizationError,
} from './appClient';

const SHA_A = 'a'.repeat(40);

// A real (but test-only, freshly generated, never used anywhere else) RSA
// keypair — RS256 signing needs a structurally valid PEM, not a fixed string.
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

describe('createDefaultGithubAppClient', () => {
  it('authorizes an active organization admin for the exact installation account', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/app/installations/555')) {
          return Response.json({ account: { login: 'Acme', type: 'Organization' } });
        }
        if (url.endsWith('/login/oauth/access_token')) {
          return Response.json({ access_token: 'ghu_ephemeral-user-token' });
        }
        if (url.endsWith('/user')) {
          return Response.json({ login: 'octocat' });
        }
        if (url.endsWith('/user/memberships/orgs/Acme')) {
          return Response.json({ state: 'active', role: 'admin' });
        }
        return new Response(null, { status: 404 });
      }),
    );

    await expect(
      createDefaultGithubAppClient().authorizeInstallation('one-time-code', 555),
    ).resolves.toEqual({
      account_login: 'Acme',
      account_type: 'Organization',
    });

    const tokenExchange = calls.find(({ url }) => url.endsWith('/login/oauth/access_token'));
    expect(tokenExchange?.init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    });
    expect(String(tokenExchange?.init?.body)).toContain('client_id=Iv1.test-client');
    expect(String(tokenExchange?.init?.body)).toContain('code=one-time-code');
    expect(calls.every(({ init }) => init?.redirect === 'manual')).toBe(true);
  });

  it('rejects an organization member who is not an admin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/app/installations/555')) {
          return Response.json({ account: { login: 'acme', type: 'Organization' } });
        }
        if (url.endsWith('/login/oauth/access_token')) {
          return Response.json({ access_token: 'ghu_ephemeral-user-token' });
        }
        if (url.endsWith('/user')) return Response.json({ login: 'member' });
        return Response.json({ state: 'active', role: 'member' });
      }),
    );

    await expect(
      createDefaultGithubAppClient().authorizeInstallation('one-time-code', 555),
    ).rejects.toBeInstanceOf(GithubAppAuthorizationError);
  });

  it('rejects a personal-account installation owned by a different user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/app/installations/555')) {
          return Response.json({ account: { login: 'owner', type: 'User' } });
        }
        if (url.endsWith('/login/oauth/access_token')) {
          return Response.json({ access_token: 'ghu_ephemeral-user-token' });
        }
        return Response.json({ login: 'someone-else' });
      }),
    );

    await expect(
      createDefaultGithubAppClient().authorizeInstallation('one-time-code', 555),
    ).rejects.toBeInstanceOf(GithubAppAuthorizationError);
  });

  it('does not expose OAuth codes, client secrets, or user tokens in errors or logs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/app/installations/555')) {
          return Response.json({ account: { login: 'acme', type: 'Organization' } });
        }
        if (url.endsWith('/login/oauth/access_token')) {
          return Response.json({ access_token: 'ghu_ephemeral-user-token' });
        }
        return new Response(null, { status: 500 });
      }),
    );

    let errorMessage = '';
    try {
      await createDefaultGithubAppClient().authorizeInstallation('sensitive-oauth-code', 555);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const observable = [
      errorMessage,
      ...[...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String),
    ].join(' ');
    expect(observable).not.toContain('sensitive-oauth-code');
    expect(observable).not.toContain('test-client-secret');
    expect(observable).not.toContain('ghu_ephemeral-user-token');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

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

  it('rejects an oversized JSON response even without Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(200 * 1024));
            controller.enqueue(new Uint8Array(60 * 1024));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await expect(
      createDefaultGithubAppClient().mintInstallationToken(1),
    ).rejects.toThrow('oversized response');
  });

  it('mintInstallationToken resolves the token from a 2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ token: 'ghs_faketoken' })),
    );
    const client = createDefaultGithubAppClient();
    await expect(client.mintInstallationToken(1)).resolves.toBe('ghs_faketoken');
  });

  it('listInstallationReposPage mints a token then fetches exactly one page', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/access_tokens')) {
          return Response.json({ token: 'ghs_faketoken' });
        }
        if (url.includes('/git/ref/')) {
          return Response.json({ object: { type: 'commit', sha: SHA_A } });
        }
        return Response.json({
          repositories: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            full_name: `acme/repo-${i}`,
            default_branch: 'main',
          })),
        });
      }),
    );
    const client = createDefaultGithubAppClient();
    const page = await client.listInstallationReposPage(1, 1);
    expect(page.repos).toHaveLength(100);
    expect(page.hasNextPage).toBe(true);
    expect(page.repos[0]).toEqual({
      provider_repo_id: '0',
      full_name: 'acme/repo-0',
      default_branch: 'main',
      default_branch_head_sha: SHA_A,
    });
    const listCalls = calls.filter((url) => url.includes('/installation/repositories'));
    expect(listCalls).toHaveLength(1); // no accumulation loop
    expect(calls).toHaveLength(102); // mint + 1 list page + one authenticated ref lookup per repo
  });

  it('honours a custom perPage before resolving branch HEADs', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        if (url.includes('/git/ref/')) {
          return Response.json({ object: { type: 'commit', sha: SHA_A } });
        }
        return Response.json({
          repositories: Array.from({ length: 25 }, (_, i) => ({
            id: i,
            full_name: `acme/repo-${i}`,
            default_branch: 'main',
          })),
        });
      }),
    );

    const page = await createDefaultGithubAppClient().listInstallationReposPage(1, 1, 25);

    expect(page.repos).toHaveLength(25);
    expect(page.hasNextPage).toBe(true); // full page for the requested perPage
    const listCalls = calls.filter((url) => url.includes('/installation/repositories'));
    expect(listCalls).toHaveLength(1);
    expect(new URL(listCalls[0]).searchParams.get('per_page')).toBe('25');
    expect(calls.filter((url) => url.includes('/git/ref/'))).toHaveLength(25);
  });

  it('bounds concurrent default-branch HEAD lookups', async () => {
    let activeHeadLookups = 0;
    let peakHeadLookups = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        if (url.includes('/installation/repositories')) {
          return Response.json({
            repositories: Array.from({ length: 12 }, (_, i) => ({
              id: i,
              full_name: `acme/repo-${i}`,
              default_branch: 'main',
            })),
          });
        }

        activeHeadLookups += 1;
        peakHeadLookups = Math.max(peakHeadLookups, activeHeadLookups);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeHeadLookups -= 1;
        return Response.json({ object: { type: 'commit', sha: SHA_A } });
      }),
    );

    const page = await createDefaultGithubAppClient().listInstallationReposPage(1, 1);
    expect(page.repos).toHaveLength(12);

    expect(peakHeadLookups).toBe(5);
  });

  it('aborts in-flight HEAD lookups and rejects at the overall discovery deadline', async () => {
    vi.useFakeTimers();
    let branchSignal: AbortSignal | undefined;
    let notifyBranchStarted: (() => void) | undefined;
    const branchStarted = new Promise<void>((resolve) => {
      notifyBranchStarted = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('/access_tokens')) {
          return Promise.resolve(Response.json({ token: 'ghs_faketoken' }));
        }
        if (url.includes('/installation/repositories')) {
          return Promise.resolve(
            Response.json({
              repositories: [{ id: 1, full_name: 'acme/repo-1', default_branch: 'main' }],
            }),
          );
        }

        branchSignal = init?.signal ?? undefined;
        notifyBranchStarted?.();
        // Deliberately ignore AbortSignal here: the outer deadline must still
        // settle the operation even if a fetch implementation fails to do so.
        return new Promise<Response>(() => undefined);
      }),
    );

    const discovery = createDefaultGithubAppClient().listInstallationReposPage(1, 1);
    const rejection = expect(discovery).rejects.toThrow(
      'GitHub repository page discovery exceeded its deadline.',
    );
    await branchStarted;
    expect(branchSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(branchSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(branchSignal?.aborted).toBe(true);
  });

  it('listInstallationReposPage maps a null default_branch through unchanged (empty repo)', async () => {
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
    const page = await client.listInstallationReposPage(1, 1);
    expect(page.repos).toEqual([
      {
        provider_repo_id: '1',
        full_name: 'acme/empty',
        default_branch: null,
        default_branch_head_sha: null,
      },
    ]);
  });

  it('treats GitHub 409 from the default ref lookup as an empty repository', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        if (url.includes('/git/ref/')) return new Response(null, { status: 409 });
        return Response.json({
          repositories: [{ id: 1, full_name: 'acme/empty', default_branch: 'main' }],
        });
      }),
    );

    const page = await createDefaultGithubAppClient().listInstallationReposPage(1, 1);
    expect(page.repos).toEqual([
      {
        provider_repo_id: '1',
        full_name: 'acme/empty',
        default_branch: 'main',
        default_branch_head_sha: null,
      },
    ]);
  });

  it('uses the installation token for an encoded default-branch ref lookup', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        if (url.includes('/git/ref/')) {
          return Response.json({ object: { type: 'commit', sha: SHA_A.toUpperCase() } });
        }
        return Response.json({
          repositories: [
            { id: 1, full_name: 'acme/widgets', default_branch: 'feature/demo' },
          ],
        });
      }),
    );

    const { repos: [repo] } = await createDefaultGithubAppClient().listInstallationReposPage(1, 1);
    const refCall = calls.find(({ url }) => url.includes('/git/ref/'));

    expect(refCall?.url).toContain('/repos/acme/widgets/git/ref/heads/feature/demo');
    expect(refCall?.init?.headers).toMatchObject({ Authorization: 'Bearer ghs_faketoken' });
    expect(repo.default_branch_head_sha).toBe(SHA_A);
  });

  it('rejects an invalid default-branch HEAD SHA', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        if (url.includes('/git/ref/')) {
          return Response.json({ object: { type: 'commit', sha: 'not-a-commit' } });
        }
        return Response.json({
          repositories: [{ id: 1, full_name: 'acme/widgets', default_branch: 'main' }],
        });
      }),
    );

    await expect(
      createDefaultGithubAppClient().listInstallationReposPage(1, 1),
    ).rejects.toBeInstanceOf(GithubAppApiError);
  });

  it('listInstallationReposPage wraps a repo-list failure (after a successful mint) as GithubAppApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
        return new Response(null, { status: 500 });
      }),
    );
    const client = createDefaultGithubAppClient();
    await expect(client.listInstallationReposPage(1, 1)).rejects.toBeInstanceOf(GithubAppApiError);
  });

  describe('getInstallationRepo (W2-09)', () => {
    it('mints a token, GETs /repos/{owner}/{repo}, and resolves the default-branch HEAD', async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url, init });
          if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
          if (url.includes('/git/ref/')) {
            return Response.json({ object: { type: 'commit', sha: SHA_A } });
          }
          return Response.json({ id: 111, full_name: 'acme/widgets', default_branch: 'main' });
        }),
      );

      const repo = await createDefaultGithubAppClient().getInstallationRepo(555, 'acme/widgets');

      expect(repo).toEqual({
        provider_repo_id: '111',
        full_name: 'acme/widgets',
        default_branch: 'main',
        default_branch_head_sha: SHA_A,
      });
      const repoCall = calls.find(({ url }) => url.endsWith('/repos/acme/widgets'));
      expect(repoCall?.init?.headers).toMatchObject({ Authorization: 'Bearer ghs_faketoken' });
    });

    it('returns null on a 404 (repo not/no-longer accessible to the installation)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
          return new Response(null, { status: 404 });
        }),
      );

      await expect(
        createDefaultGithubAppClient().getInstallationRepo(555, 'acme/gone'),
      ).resolves.toBeNull();
    });

    it('resolves a null default_branch_head_sha for an empty repo (409 from the ref lookup)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
          if (url.includes('/git/ref/')) return new Response(null, { status: 409 });
          return Response.json({ id: 111, full_name: 'acme/empty', default_branch: 'main' });
        }),
      );

      await expect(
        createDefaultGithubAppClient().getInstallationRepo(555, 'acme/empty'),
      ).resolves.toEqual({
        provider_repo_id: '111',
        full_name: 'acme/empty',
        default_branch: 'main',
        default_branch_head_sha: null,
      });
    });

    it('resolves default_branch_head_sha: null for a repo with no default_branch at all (empty, no commits)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
          return Response.json({ id: 111, full_name: 'acme/empty', default_branch: null });
        }),
      );

      await expect(
        createDefaultGithubAppClient().getInstallationRepo(555, 'acme/empty'),
      ).resolves.toEqual({
        provider_repo_id: '111',
        full_name: 'acme/empty',
        default_branch: null,
        default_branch_head_sha: null,
      });
    });

    it('wraps a non-2xx/non-404 repo-lookup failure as GithubAppApiError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_faketoken' });
          return new Response(null, { status: 500 });
        }),
      );

      await expect(
        createDefaultGithubAppClient().getInstallationRepo(555, 'acme/widgets'),
      ).rejects.toBeInstanceOf(GithubAppApiError);
    });

    it('wraps a malformed full_name (not owner/name) as GithubAppApiError, never issues the repo GET', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ token: 'ghs_faketoken' })));

      await expect(
        createDefaultGithubAppClient().getInstallationRepo(555, 'not-owner-slash-name'),
      ).rejects.toBeInstanceOf(GithubAppApiError);
    });

    it('wraps a failed token mint as GithubAppApiError', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));

      await expect(
        createDefaultGithubAppClient().getInstallationRepo(555, 'acme/widgets'),
      ).rejects.toBeInstanceOf(GithubAppApiError);
    });
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

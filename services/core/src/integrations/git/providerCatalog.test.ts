// W3-04 gapfill (GAP-6, GAP-8). Leading-red coverage for the configuration-driven
// provider registry: spec.md's Interfaces section pins
//   parseGitProviderCatalog(raw): GitProviderCatalogEntry[]  — pure parser
//   loadGitProviderRegistry(registrations?): GitProviderRegistry — reads config, fails
//     closed on unknown/duplicate/malformed entries, malformed JSON, a malformed
//     credentialRef, or a mockOnly provider under NODE_ENV === 'production'.
// and GitProviderContext.resolveCredential() (types.ts), which "Rejects with
// GitProviderCredentialError when credentialRef is null or unresolvable."
//
// Broker-free: pure config parsing, no Redis/Neo4j.

import { afterEach, describe, expect, it } from 'vitest';
import {
  getSecret,
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import type { GitProviderRegistration } from './types';

afterEach(() => {
  resetConfigForTests();
  resetSecretsForTests();
});

const REGISTRATIONS: Record<string, GitProviderRegistration> = {
  github: { create: (context) => ({ provider: 'github', resolveChanges: async () => ({ refName: null, edits: [] }), __context: context } as never) },
  fakehub: {
    create: (context) => ({ provider: 'fakehub', resolveChanges: async () => ({ refName: null, edits: [] }), __context: context } as never),
    mockOnly: true,
  },
};

describe('parseGitProviderCatalog (GAP-6)', () => {
  // @spec AC-9
  it('parses a well-formed catalog into normalized entries with credentialRef defaulted to null', async () => {
    const { parseGitProviderCatalog } = await import('./providerCatalog');
    expect(parseGitProviderCatalog('[{"provider":"github"}]')).toEqual([
      { provider: 'github', credentialRef: null },
    ]);
    expect(
      parseGitProviderCatalog(
        '[{"provider":"github"},{"provider":"fakehub","credentialRef":"env://REDIS_PASSWORD"}]',
      ),
    ).toEqual([
      { provider: 'github', credentialRef: null },
      { provider: 'fakehub', credentialRef: 'env://REDIS_PASSWORD' },
    ]);
  });

  // @spec EC-18
  it.each([
    ['malformed JSON', 'not json'],
    ['not an array', '{"provider":"github"}'],
    ['an empty array', '[]'],
    ['an unknown object key', '[{"provider":"github","nickname":"x"}]'],
    ['a non-env:// credentialRef', '[{"provider":"github","credentialRef":"vault://secret"}]'],
  ])('throws GitProviderCatalogError on %s', async (_label, raw) => {
    const { GitProviderCatalogError, parseGitProviderCatalog } = await import('./providerCatalog');
    expect(() => parseGitProviderCatalog(raw)).toThrow(GitProviderCatalogError);
  });
});

describe('loadGitProviderRegistry (GAP-6)', () => {
  // @spec AC-9
  it('builds a registry containing every catalog-listed provider, resolved against the registration manifest', async () => {
    setConfigOverrideForTests(
      'GIT_PROVIDER_CATALOG',
      '[{"provider":"github"},{"provider":"fakehub"}]',
    );
    const { loadGitProviderRegistry } = await import('./providerCatalog');
    const registry = loadGitProviderRegistry(REGISTRATIONS);
    expect(registry.get('github').provider).toBe('github');
    expect(registry.get('fakehub').provider).toBe('fakehub');
  });

  // @spec AC-9 EC-19
  it('defaults to a github-only registry when GIT_PROVIDER_CATALOG is unset', async () => {
    const { loadGitProviderRegistry } = await import('./providerCatalog');
    const registry = loadGitProviderRegistry(REGISTRATIONS);
    expect(registry.get('github').provider).toBe('github');
    expect(() => registry.get('fakehub')).toThrow();
  });

  // @spec EC-18
  it('throws GitProviderCatalogError on an unknown provider id and does not fall back to github-only', async () => {
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG', '[{"provider":"bitbucket"}]');
    const { GitProviderCatalogError, loadGitProviderRegistry } = await import('./providerCatalog');
    expect(() => loadGitProviderRegistry(REGISTRATIONS)).toThrow(GitProviderCatalogError);
  });

  // @spec EC-18
  it('throws GitProviderCatalogError on a duplicate provider id', async () => {
    setConfigOverrideForTests(
      'GIT_PROVIDER_CATALOG',
      '[{"provider":"github"},{"provider":"github"}]',
    );
    const { GitProviderCatalogError, loadGitProviderRegistry } = await import('./providerCatalog');
    expect(() => loadGitProviderRegistry(REGISTRATIONS)).toThrow(GitProviderCatalogError);
  });

  // @spec AC-9 EC-18 — regression for security finding FND-7c51522045f7: a `{...}` object
  // literal used as the registration manifest resolves inherited Object.prototype members
  // through a plain indexed lookup, so an unknown provider id that happens to name one
  // (e.g. "constructor") must still be refused, exactly like a genuinely unknown id.
  it.each([
    'constructor',
    '__proto__',
    'prototype',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ])('throws GitProviderCatalogError on the inherited/reserved provider id "%s"', async (provider) => {
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG', JSON.stringify([{ provider }]));
    const { GitProviderCatalogError, loadGitProviderRegistry } = await import('./providerCatalog');
    // Deliberately passed as an ordinary `{...}` object literal (not GIT_PROVIDER_REGISTRATIONS'
    // own null-prototype construction) so this proves the lookup guard itself is safe, not just
    // one particular manifest's construction.
    expect(() => loadGitProviderRegistry(REGISTRATIONS)).toThrow(GitProviderCatalogError);
  });

  // @spec AC-9 EC-18 — same regression, exercised against the real exported manifest
  // (providers/index.ts's GIT_PROVIDER_REGISTRATIONS) rather than the test double above, so
  // the fix is proven end-to-end against what actually ships.
  it('throws GitProviderCatalogError on "constructor" against the real GIT_PROVIDER_REGISTRATIONS manifest', async () => {
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG', '[{"provider":"constructor"}]');
    const { GitProviderCatalogError, loadGitProviderRegistry } = await import('./providerCatalog');
    expect(() => loadGitProviderRegistry()).toThrow(GitProviderCatalogError);
  });

  // @spec AC-10 EC-20
  it('refuses a mockOnly provider (fakehub) when NODE_ENV is production', async () => {
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG', '[{"provider":"fakehub"}]');
    setConfigOverrideForTests('NODE_ENV', 'production');
    const { loadGitProviderRegistry } = await import('./providerCatalog');
    expect(() => loadGitProviderRegistry(REGISTRATIONS)).toThrow(/fakehub/);
  });

  // @spec AC-10 EC-20
  it('registers a mockOnly provider (fakehub) normally outside production', async () => {
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG', '[{"provider":"fakehub"}]');
    setConfigOverrideForTests('NODE_ENV', 'test');
    const { loadGitProviderRegistry } = await import('./providerCatalog');
    const registry = loadGitProviderRegistry(REGISTRATIONS);
    expect(registry.get('fakehub').provider).toBe('fakehub');
  });

  // @spec AC-12
  it('passes a GitProviderContext carrying the provider id and credentialRef to every adapter factory', async () => {
    setConfigOverrideForTests(
      'GIT_PROVIDER_CATALOG',
      '[{"provider":"github","credentialRef":"env://REDIS_PASSWORD"}]',
    );
    const seen: unknown[] = [];
    const spyRegistrations: Record<string, GitProviderRegistration> = {
      github: {
        create: (context) => {
          seen.push(context);
          return { provider: 'github', resolveChanges: async () => ({ refName: null, edits: [] }) };
        },
      },
    };
    const { loadGitProviderRegistry } = await import('./providerCatalog');
    loadGitProviderRegistry(spyRegistrations);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ provider: 'github', credentialRef: 'env://REDIS_PASSWORD' });
    expect(typeof (seen[0] as { resolveCredential: unknown }).resolveCredential).toBe('function');
  });
});

describe('GitProviderContext.resolveCredential (GAP-8)', () => {
  // @spec AC-12 EC-23
  it('rejects with GitProviderCredentialError when credentialRef is null', async () => {
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG', '[{"provider":"github"}]');
    let context: { resolveCredential(): Promise<string> } | undefined;
    const spyRegistrations: Record<string, GitProviderRegistration> = {
      github: {
        create: (c) => {
          context = c;
          return { provider: 'github', resolveChanges: async () => ({ refName: null, edits: [] }) };
        },
      },
    };
    const { GitProviderCredentialError, loadGitProviderRegistry } = await import('./providerCatalog');
    loadGitProviderRegistry(spyRegistrations);
    await expect(context!.resolveCredential()).rejects.toBeInstanceOf(GitProviderCredentialError);
  });

  // @spec EC-22
  it('rejects with GitProviderCredentialError, without leaking the secret, when the referenced secret resolves empty', async () => {
    setConfigOverrideForTests(
      'GIT_PROVIDER_CATALOG',
      '[{"provider":"github","credentialRef":"env://REDIS_PASSWORD"}]',
    );
    setSecretBackendForTests(async () => '   ');
    let context: { resolveCredential(): Promise<string> } | undefined;
    const spyRegistrations: Record<string, GitProviderRegistration> = {
      github: {
        create: (c) => {
          context = c;
          return { provider: 'github', resolveChanges: async () => ({ refName: null, edits: [] }) };
        },
      },
    };
    const { GitProviderCredentialError, loadGitProviderRegistry } = await import('./providerCatalog');
    loadGitProviderRegistry(spyRegistrations);
    let caught: unknown;
    try {
      await context!.resolveCredential();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitProviderCredentialError);
    expect((caught as Error).message).not.toMatch(/REDIS_PASSWORD|resolved credential value/);
  });

  // @spec EC-22
  it('rejects with GitProviderCredentialError when credentialRef names a secret outside SECRET_NAMES', async () => {
    setConfigOverrideForTests(
      'GIT_PROVIDER_CATALOG',
      '[{"provider":"github","credentialRef":"env://NOT_A_REAL_SECRET"}]',
    );
    let context: { resolveCredential(): Promise<string> } | undefined;
    const spyRegistrations: Record<string, GitProviderRegistration> = {
      github: {
        create: (c) => {
          context = c;
          return { provider: 'github', resolveChanges: async () => ({ refName: null, edits: [] }) };
        },
      },
    };
    const { GitProviderCredentialError, loadGitProviderRegistry } = await import('./providerCatalog');
    loadGitProviderRegistry(spyRegistrations);
    await expect(context!.resolveCredential()).rejects.toBeInstanceOf(GitProviderCredentialError);
  });

  // @spec AC-12
  it('resolves the secret value referenced by credentialRef through the shared secret loader', async () => {
    setConfigOverrideForTests(
      'GIT_PROVIDER_CATALOG',
      '[{"provider":"github","credentialRef":"env://REDIS_PASSWORD"}]',
    );
    setSecretBackendForTests(async () => 'super-secret-token');
    let context: { resolveCredential(): Promise<string> } | undefined;
    const spyRegistrations: Record<string, GitProviderRegistration> = {
      github: {
        create: (c) => {
          context = c;
          return { provider: 'github', resolveChanges: async () => ({ refName: null, edits: [] }) };
        },
      },
    };
    const { loadGitProviderRegistry } = await import('./providerCatalog');
    loadGitProviderRegistry(spyRegistrations);
    await expect(context!.resolveCredential()).resolves.toBe('super-secret-token');
    await getSecret('env://REDIS_PASSWORD'); // sanity: the same authorized-ref loader path
  });
});

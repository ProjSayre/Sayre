// W3-04 gapfill (GAP-6, GAP-8). Parses the GIT_PROVIDER_CATALOG configuration value and
// resolves it against a closed, in-repo registration manifest (providers/index.ts) into a
// GitProviderRegistry — the configuration-driven registration path GAP-6 found entirely
// missing. Fails closed on every malformed shape (spec.md EC-18): never falls back to a
// silent github-only registry once the config value itself is present but broken.
//
// Deliberately a closed in-repo map rather than a config-supplied module path — see
// providers/index.ts's own header and spec.md's Open Question Q-1
// (.claude/rules/security-multitenancy.md: configuration must not name arbitrary code to
// load).

import { getConfig, getSecret, type SecretRef } from '@sayre/config';
import { GitProviderRegistry } from './providerRegistry';
import { GIT_PROVIDER_REGISTRATIONS } from './providers/index';
import type { GitProviderContext, GitProviderRegistration } from './types';

export interface GitProviderCatalogEntry {
  provider: string;
  credentialRef: SecretRef | null;
}

export class GitProviderCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProviderCatalogError';
  }
}

export class GitProviderCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProviderCredentialError';
  }
}

const ENV_REF_RE = /^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/;

function invalidCatalog(): never {
  // Intentionally generic: never echo the raw catalog value (it may carry a
  // credentialRef-shaped string an attacker crafted).
  throw new GitProviderCatalogError('GIT_PROVIDER_CATALOG is malformed.');
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    invalidCatalog();
  }
}

/**
 * Pure parser over the raw config string. Throws GitProviderCatalogError on any malformed
 * input. Never partially succeeds.
 */
export function parseGitProviderCatalog(raw: string): GitProviderCatalogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidCatalog();
  }
  if (!Array.isArray(parsed) || parsed.length === 0) invalidCatalog();

  const entries: GitProviderCatalogEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) invalidCatalog();
    const record = item as Record<string, unknown>;
    exactKeys(record, ['provider'], ['credentialRef']);

    if (typeof record.provider !== 'string' || record.provider.trim().length === 0) {
      invalidCatalog();
    }

    let credentialRef: SecretRef | null = null;
    if (record.credentialRef !== undefined) {
      if (typeof record.credentialRef !== 'string' || !ENV_REF_RE.test(record.credentialRef)) {
        invalidCatalog();
      }
      credentialRef = record.credentialRef as SecretRef;
    }

    entries.push({ provider: record.provider as string, credentialRef });
  }
  return entries;
}

function buildContext(entry: GitProviderCatalogEntry): GitProviderContext {
  return {
    provider: entry.provider,
    credentialRef: entry.credentialRef,
    async resolveCredential(): Promise<string> {
      if (entry.credentialRef === null) {
        throw new GitProviderCredentialError(
          `No credential is configured for git provider "${entry.provider}".`,
        );
      }
      try {
        const value = await getSecret(entry.credentialRef);
        if (value.trim().length === 0) {
          throw new GitProviderCredentialError(
            `The credential resolved for git provider "${entry.provider}" is empty.`,
          );
        }
        return value;
      } catch (error) {
        if (error instanceof GitProviderCredentialError) throw error;
        // Never echo the reference name/value or the resolved secret itself.
        throw new GitProviderCredentialError(
          `Failed to resolve the configured credential for git provider "${entry.provider}".`,
        );
      }
    },
  };
}

/**
 * Reads GIT_PROVIDER_CATALOG, parses it, resolves each entry against `registrations`, and
 * returns a fully populated registry. Fails closed (throws) on: unknown provider id,
 * duplicate provider id, empty catalog, malformed JSON, malformed credentialRef, or a
 * mockOnly provider under NODE_ENV === 'production'.
 */
export function loadGitProviderRegistry(
  registrations: Readonly<Record<string, GitProviderRegistration>> = GIT_PROVIDER_REGISTRATIONS,
): GitProviderRegistry {
  const entries = parseGitProviderCatalog(getConfig('GIT_PROVIDER_CATALOG'));
  const registry = new GitProviderRegistry();
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.provider)) {
      throw new GitProviderCatalogError(
        `GIT_PROVIDER_CATALOG lists provider "${entry.provider}" more than once.`,
      );
    }
    seen.add(entry.provider);

    // Explicit own-property guard (not just an `=== undefined` check on the indexed
    // lookup): a `registrations` map built as an ordinary `{...}` object literal — as the
    // default GIT_PROVIDER_REGISTRATIONS now avoids, but any caller-supplied
    // `registrations` argument (e.g. in tests) may still be — resolves inherited
    // Object.prototype members (e.g. "constructor", "toString") through a plain indexed
    // lookup for a provider id that was never actually registered. Checking
    // hasOwnProperty first closes that off regardless of how `registrations` was built.
    // See W3-04 gapfill security finding FND-7c51522045f7.
    if (!Object.prototype.hasOwnProperty.call(registrations, entry.provider)) {
      throw new GitProviderCatalogError(
        `GIT_PROVIDER_CATALOG names unknown git provider "${entry.provider}".`,
      );
    }
    const registration = registrations[entry.provider];
    if (registration.mockOnly === true && getConfig('NODE_ENV') === 'production') {
      throw new GitProviderCatalogError(
        `Mock git provider "${entry.provider}" cannot be registered when NODE_ENV=production.`,
      );
    }

    registry.register(registration.create(buildContext(entry)));
  }

  return registry;
}

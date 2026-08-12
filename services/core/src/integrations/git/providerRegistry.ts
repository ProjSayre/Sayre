import type { GitProviderAdapter } from './types';

export class UnknownGitProviderError extends Error {
  constructor(provider: string) {
    super(`No git synchronization adapter is registered for provider ${provider}.`);
    this.name = 'UnknownGitProviderError';
  }
}

export class GitProviderRegistry {
  private readonly adapters = new Map<string, GitProviderAdapter>();

  constructor(adapters: readonly GitProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: GitProviderAdapter): void {
    const provider = adapter.provider.trim();
    if (provider.length === 0) throw new Error('A git provider id cannot be blank.');
    if (this.adapters.has(provider)) {
      throw new Error(`A git provider adapter is already registered for ${provider}.`);
    }
    this.adapters.set(provider, adapter);
  }

  get(provider: string): GitProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) throw new UnknownGitProviderError(provider);
    return adapter;
  }

  /** W3-04 gapfill (GAP-6): every registered provider id, for the config loader
   *  (providerCatalog.ts) to verify a catalog entry against. */
  providers(): string[] {
    return [...this.adapters.keys()];
  }
}

import { describe, expect, it } from 'vitest';
import { GitProviderRegistry, UnknownGitProviderError } from './providerRegistry';
import type { GitProviderAdapter, ProviderChangeSet } from './types';

// W3-04 gapfill (GAP-7): this file previously imported `FakeHubProviderAdapter` from
// `./__fixtures__/fakehubProvider`, a discard-both-arguments stand-in that has been
// deleted (replaced by the real `providers/fakehub.ts` adapter — see
// providers/fakehub.test.ts). The two tests below only exercise
// GitProviderRegistry's own register/get/providers() bookkeeping — they never needed a
// real provider, only *some* adapter — so a tiny local stub replaces the deleted
// shared fixture rather than pulling in the real fakehub adapter's payload-shape
// requirements, which would change what these tests are about.
class StaticProviderAdapter implements GitProviderAdapter {
  readonly provider = 'fakehub';
  constructor(private readonly changes: ProviderChangeSet) {}
  async resolveChanges(): Promise<ProviderChangeSet> {
    return this.changes;
  }
}

describe('GitProviderRegistry', () => {
  // W3-04 gapfill (GAP-7): the previous test here, "registers a second provider through
  // one adapter module without a pipeline switch," is DELETED (not amended) per
  // spec.md's Approach step 12 and AC-11 — it asserted only direct constructor
  // injection into a bare registry (no configuration, no startGitSyncWorker, no queue
  // path, no graph write) and would still pass with GAP-6 fully unfixed. Its real
  // replacement coverage lives in providerCatalog.test.ts (configuration -> registry)
  // and __tests__/w3-04.acceptance.integration.test.ts (configuration -> worker ->
  // graph).

  it('rejects duplicate and unknown providers explicitly', () => {
    const adapter = new StaticProviderAdapter({ refName: null, edits: [] });
    const registry = new GitProviderRegistry([adapter]);
    expect(() => registry.register(adapter)).toThrow(/already registered/);
    expect(() => registry.get('missing')).toThrow(UnknownGitProviderError);
  });

  // @spec AC-9
  it('providers() lists every registered provider id, for the config loader to verify against', () => {
    const registry = new GitProviderRegistry([
      new StaticProviderAdapter({ refName: null, edits: [] }),
    ]);
    expect(registry.providers()).toEqual(['fakehub']);
  });
});

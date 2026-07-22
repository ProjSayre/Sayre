import { describe, expect, it } from 'vitest';
import { FakeHubProviderAdapter } from './__fixtures__/fakehubProvider';
import { GitProviderRegistry, UnknownGitProviderError } from './providerRegistry';
import type { ProviderRepoEvent } from './types';

const fakeEvent: ProviderRepoEvent = {
  provider: 'fakehub',
  type: 'push',
  repo: { provider_repo_id: 'fake-1', full_name: 'acme/repo', repo_id: null },
  ref: 'refs/heads/main',
  installation_id: 'fake-installation',
  delivery_id: 'fake-delivery',
  payload: {},
};

describe('GitProviderRegistry', () => {
  it('registers a second provider through one adapter module without a pipeline switch', async () => {
    const expected = { refName: 'refs/heads/main', edits: [] };
    const registry = new GitProviderRegistry([new FakeHubProviderAdapter(expected)]);

    await expect(registry.get(fakeEvent.provider).resolveChanges(fakeEvent, '2026-01-01T00:00:00Z'))
      .resolves.toEqual(expected);
  });

  it('rejects duplicate and unknown providers explicitly', () => {
    const adapter = new FakeHubProviderAdapter({ refName: null, edits: [] });
    const registry = new GitProviderRegistry([adapter]);
    expect(() => registry.register(adapter)).toThrow(/already registered/);
    expect(() => registry.get('missing')).toThrow(UnknownGitProviderError);
  });
});

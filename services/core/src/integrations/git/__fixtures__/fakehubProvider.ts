import type {
  GitProviderAdapter,
  ProviderChangeSet,
  ProviderRepoEvent,
} from '../types';

export class FakeHubProviderAdapter implements GitProviderAdapter {
  readonly provider = 'fakehub';

  constructor(private readonly changes: ProviderChangeSet) {}

  async resolveChanges(
    event: ProviderRepoEvent,
    occurredAt: string,
  ): Promise<ProviderChangeSet> {
    void event;
    void occurredAt;
    return this.changes;
  }
}

import type { TicketProvider, TicketProviderAdapter } from './types';

export class TicketProviderRegistry {
  private readonly adapters = new Map<TicketProvider, TicketProviderAdapter>();

  constructor(adapters: readonly TicketProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: TicketProviderAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`Ticket provider ${adapter.provider} is already registered.`);
    }
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: TicketProvider): TicketProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) {
      throw new Error(`Ticket provider ${provider} is not registered.`);
    }
    return adapter;
  }
}

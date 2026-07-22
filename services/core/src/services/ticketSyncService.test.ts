import { describe, expect, it, vi } from 'vitest';
import { makeEnvelope } from '../queue/envelope';
import { TicketProviderRegistry } from '../integrations/tickets/providerRegistry';
import type { NormalizedTicket, TicketProviderAdapter } from '../integrations/tickets/types';
import { syncTicket } from './ticketSyncService';

const normalized: NormalizedTicket = {
  provider: 'jira',
  externalId: 'PAY-42',
  title: 'Fix checkout',
  description: '[sayre:file:src/pay.ts] [sayre:feature:Checkout]',
  status: 'In Progress',
  url: 'https://jira.test/PAY-42',
  updatedAt: '2026-07-22T12:00:00Z',
  references: [
    { kind: 'file', value: 'src/pay.ts' },
    { kind: 'feature', value: 'Checkout' },
  ],
  raw: { key: 'PAY-42' },
};

function adapter(): TicketProviderAdapter {
  return {
    provider: 'jira',
    externalIdFromWebhook: () => 'PAY-42',
    fetchTicket: vi.fn(async () => normalized),
    updateTicket: vi.fn(async () => normalized),
  };
}

describe('syncTicket', () => {
  it('mirrors a created ticket and its File/Feature references through one shared path', async () => {
    const provider = adapter();
    const cache = { upsert: vi.fn(async () => undefined) };
    const graph = {
      apply: vi.fn(async () => ({ linkedNodes: 2 })),
      close: vi.fn(async () => undefined),
    };
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'ticket.inbound',
      source: 'jira-webhook',
      payload: {
        provider: 'jira' as const,
        direction: 'inbound' as const,
        external_ticket_id: 'PAY-42',
        repository_id: 'server-repo',
        ref_name: 'refs/heads/main',
      },
    });

    await expect(syncTicket(envelope, {
      providers: new TicketProviderRegistry([provider]),
      cache,
      graph,
    })).resolves.toEqual({
      provider: 'jira',
      externalTicketId: 'PAY-42',
      linkedNodes: 2,
    });
    const expectedWrite = {
      orgId: 'server-org',
      repositoryId: 'server-repo',
      refName: 'refs/heads/main',
      ticket: normalized,
    };
    expect(provider.fetchTicket).toHaveBeenCalledWith('PAY-42');
    expect(cache.upsert).toHaveBeenCalledWith(expectedWrite);
    expect(graph.apply).toHaveBeenCalledWith(expectedWrite);
  });

  it('propagates an authorized outbound edit before refreshing both mirrors', async () => {
    const provider = adapter();
    const dependencies = {
      providers: new TicketProviderRegistry([provider]),
      cache: { upsert: vi.fn(async () => undefined) },
      graph: {
        apply: vi.fn(async () => ({ linkedNodes: 2 })),
        close: vi.fn(async () => undefined),
      },
    };
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'ticket.outbound',
      source: 'sayre-ticket-update',
      payload: {
        provider: 'jira' as const,
        direction: 'outbound' as const,
        external_ticket_id: 'PAY-42',
        repository_id: 'server-repo',
        ref_name: 'refs/heads/main',
        patch: { title: 'Updated' },
      },
    });

    await syncTicket(envelope, dependencies);
    expect(provider.updateTicket).toHaveBeenCalledWith('PAY-42', { title: 'Updated' });
    expect(provider.fetchTicket).not.toHaveBeenCalled();
    expect(dependencies.cache.upsert).toHaveBeenCalledOnce();
    expect(dependencies.graph.apply).toHaveBeenCalledOnce();
  });
});

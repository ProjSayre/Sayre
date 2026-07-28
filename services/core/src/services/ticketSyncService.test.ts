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

const untagged: NormalizedTicket = {
  ...normalized,
  description: 'No explicit tag in this one.',
  references: [],
};

function adapter(ticket: NormalizedTicket = normalized): TicketProviderAdapter {
  return {
    provider: 'jira',
    externalIdFromWebhook: () => 'PAY-42',
    fetchTicket: vi.fn(async () => ticket),
    updateTicket: vi.fn(async () => ticket),
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

  it('never checks for or requests an AI-inferred match when the ticket already has an explicit tag', async () => {
    const provider = adapter();
    const resolveInferredReferenceNodeId = vi.fn(async () => null);
    const requestReferenceMatch = vi.fn(async () => undefined);
    const graph = { apply: vi.fn(async () => ({ linkedNodes: 2 })), close: vi.fn(async () => undefined) };
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

    await syncTicket(envelope, {
      providers: new TicketProviderRegistry([provider]),
      cache: { upsert: vi.fn(async () => undefined), resolveInferredReferenceNodeId },
      graph,
      requestReferenceMatch,
    });

    expect(resolveInferredReferenceNodeId).not.toHaveBeenCalled();
    expect(requestReferenceMatch).not.toHaveBeenCalled();
    expect(graph.apply).toHaveBeenCalledWith(expect.objectContaining({ ticket: normalized }));
  });

  it('merges a prior cycle\'s AI-inferred match into the graph write, without re-requesting one', async () => {
    const provider = adapter(untagged);
    const resolveInferredReferenceNodeId = vi.fn(async () => 'inferred-node-uid-123');
    const requestReferenceMatch = vi.fn(async () => undefined);
    const graph = { apply: vi.fn(async () => ({ linkedNodes: 1 })), close: vi.fn(async () => undefined) };
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'ticket.inbound',
      source: 'jira-schedule',
      payload: {
        provider: 'jira' as const,
        direction: 'inbound' as const,
        external_ticket_id: 'PAY-42',
        repository_id: 'server-repo',
        ref_name: 'refs/heads/main',
      },
    });

    await syncTicket(envelope, {
      providers: new TicketProviderRegistry([provider]),
      cache: { upsert: vi.fn(async () => undefined), resolveInferredReferenceNodeId },
      graph,
      requestReferenceMatch,
    });

    expect(resolveInferredReferenceNodeId).toHaveBeenCalledWith({
      orgId: 'server-org',
      provider: 'jira',
      externalTicketId: 'PAY-42',
    });
    expect(requestReferenceMatch).not.toHaveBeenCalled();
    expect(graph.apply).toHaveBeenCalledWith(expect.objectContaining({
      ticket: expect.objectContaining({
        references: [{ kind: 'node_id', value: 'inferred-node-uid-123' }],
      }),
    }));
  });

  it('requests an AI-inferred match when a ticket has no tag and no prior inferred value, without blocking the sync', async () => {
    const provider = adapter(untagged);
    const resolveInferredReferenceNodeId = vi.fn(async () => null);
    const requestReferenceMatch = vi.fn(async () => undefined);
    const graph = { apply: vi.fn(async () => ({ linkedNodes: 0 })), close: vi.fn(async () => undefined) };
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'ticket.inbound',
      source: 'jira-schedule',
      payload: {
        provider: 'jira' as const,
        direction: 'inbound' as const,
        external_ticket_id: 'PAY-42',
        repository_id: 'server-repo',
        ref_name: 'refs/heads/main',
      },
    });

    const result = await syncTicket(envelope, {
      providers: new TicketProviderRegistry([provider]),
      cache: { upsert: vi.fn(async () => undefined), resolveInferredReferenceNodeId },
      graph,
      requestReferenceMatch,
    });

    expect(result).toEqual({ provider: 'jira', externalTicketId: 'PAY-42', linkedNodes: 0 });
    expect(requestReferenceMatch).toHaveBeenCalledWith('server-org', {
      repository_id: 'server-repo',
      ref_name: 'refs/heads/main',
      provider: 'jira',
      external_ticket_id: 'PAY-42',
      title: untagged.title,
      description: untagged.description,
    });
    expect(graph.apply).toHaveBeenCalledWith(expect.objectContaining({
      ticket: expect.objectContaining({ references: [] }),
    }));
  });

  it('never requests an AI-inferred match for an outbound (Sayre-authored) edit', async () => {
    const provider = adapter(untagged);
    const resolveInferredReferenceNodeId = vi.fn(async () => null);
    const requestReferenceMatch = vi.fn(async () => undefined);
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

    await syncTicket(envelope, {
      providers: new TicketProviderRegistry([provider]),
      cache: { upsert: vi.fn(async () => undefined), resolveInferredReferenceNodeId },
      graph: { apply: vi.fn(async () => ({ linkedNodes: 0 })), close: vi.fn(async () => undefined) },
      requestReferenceMatch,
    });

    expect(resolveInferredReferenceNodeId).not.toHaveBeenCalled();
    expect(requestReferenceMatch).not.toHaveBeenCalled();
  });
});

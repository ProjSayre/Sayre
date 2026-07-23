import { describe, expect, it, vi } from 'vitest';
import { TicketProviderRegistry } from '../integrations/tickets/providerRegistry';
import type { TicketProviderAdapter } from '../integrations/tickets/types';
import {
  enqueueScheduledTicketSync,
  enqueueTicketUpdate,
  enqueueTicketWebhook,
  type EnqueueTicket,
} from './ticketSyncIngress';

const scope = {
  orgId: 'server-org',
  repositoryId: 'server-repo',
  refName: 'refs/heads/main',
};

const adapter: TicketProviderAdapter = {
  provider: 'jira',
  externalIdFromWebhook: (payload) => {
    const issue = (payload as { issue?: { key?: string } }).issue;
    return issue?.key ?? null;
  },
  fetchTicket: vi.fn(),
  updateTicket: vi.fn(),
};

describe('ticket sync ingress', () => {
  it('uses verified server scope and takes only the ticket id from a webhook', async () => {
    const enqueueJob = vi.fn(async () => 'job-1') as EnqueueTicket;
    const result = await enqueueTicketWebhook({
      provider: 'jira',
      scope,
      deliveryId: 'delivery-1',
      webhook: {
        org_id: 'forged-org',
        repository_id: 'forged-repo',
        issue: { key: 'PAY-42' },
      },
    }, new TicketProviderRegistry([adapter]), enqueueJob);

    expect(result).toBe('job-1');
    expect(enqueueJob).toHaveBeenCalledWith('jira', expect.objectContaining({
      org_id: 'server-org',
      source: 'jira-webhook',
      payload: {
        provider: 'jira',
        direction: 'inbound',
        external_ticket_id: 'PAY-42',
        repository_id: 'server-repo',
        ref_name: 'refs/heads/main',
      },
    }));
  });

  it('supports de-duplicated scheduled pulls and outbound edits', async () => {
    const enqueueJob = vi.fn(async (_provider, envelope) => envelope.idempotency_key) as EnqueueTicket;
    const scheduled = await enqueueScheduledTicketSync({
      provider: 'linear',
      scope,
      externalTicketIds: ['LIN-1', 'LIN-1', '', 'LIN-2'],
      cycleId: 'cycle-1',
    }, enqueueJob);
    expect(scheduled).toHaveLength(2);
    expect(enqueueJob).toHaveBeenCalledTimes(2);

    await enqueueTicketUpdate({
      provider: 'linear',
      scope,
      externalTicketId: 'LIN-1',
      patch: { description: '[sayre:feature:Checkout]' },
      requestId: 'request-1',
    }, enqueueJob);
    expect(enqueueJob).toHaveBeenLastCalledWith('linear', expect.objectContaining({
      type: 'ticket.outbound',
      payload: expect.objectContaining({
        direction: 'outbound',
        patch: { description: '[sayre:feature:Checkout]' },
      }),
    }));
  });
});

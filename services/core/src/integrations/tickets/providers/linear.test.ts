import { describe, expect, it, vi } from 'vitest';
import {
  LINEAR_ISSUE_QUERY,
  LINEAR_ISSUE_UPDATE,
  LinearProviderAdapter,
} from './linear';

const issue = {
  id: 'linear-uuid',
  identifier: 'LIN-42',
  title: 'Fix checkout',
  description: 'Touches [sayre:file:src/pay.ts]',
  url: 'https://linear.app/acme/issue/LIN-42/fix-checkout',
  updatedAt: '2026-07-22T12:00:00Z',
  state: { name: 'Started' },
};

describe('LinearProviderAdapter', () => {
  it('fetches and normalizes an issue through Linear GraphQL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { issue },
    }), { status: 200 }));
    const loadToken = vi.fn(async () => 'linear-secret-token');
    const adapter = new LinearProviderAdapter(loadToken, fetcher, () => 'https://linear.test/graphql');

    const ticket = await adapter.fetchTicket('LIN-42');

    expect(loadToken).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toBe('https://linear.test/graphql');
    expect(request?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer linear-secret-token',
    }));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      query: LINEAR_ISSUE_QUERY,
      variables: { id: 'LIN-42' },
    });
    expect(ticket).toEqual(expect.objectContaining({
      provider: 'linear',
      externalId: 'LIN-42',
      status: 'Started',
      references: [{ kind: 'file', value: 'src/pay.ts' }],
    }));
  });

  it('uses issueUpdate for the outbound side and rejects GraphQL errors', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ message: 'denied' }],
      }), { status: 200 }));
    const adapter = new LinearProviderAdapter(
      async () => 'token',
      fetcher,
      () => 'https://linear.test/graphql',
    );

    await expect(adapter.updateTicket('LIN-42', { title: 'Updated' }))
      .resolves.toEqual(expect.objectContaining({ externalId: 'LIN-42' }));
    const firstBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(firstBody).toEqual({
      query: LINEAR_ISSUE_UPDATE,
      variables: { id: 'LIN-42', input: { title: 'Updated' } },
    });
    await expect(adapter.fetchTicket('LIN-42')).rejects.toThrow('Linear GraphQL request failed.');
  });

  it('accepts only Issue webhook events', () => {
    const adapter = new LinearProviderAdapter();
    expect(adapter.externalIdFromWebhook({
      type: 'Issue',
      data: { identifier: 'LIN-42' },
    })).toBe('LIN-42');
    expect(adapter.externalIdFromWebhook({
      type: 'Comment',
      data: { issueId: 'linear-uuid' },
    })).toBeNull();
  });
});

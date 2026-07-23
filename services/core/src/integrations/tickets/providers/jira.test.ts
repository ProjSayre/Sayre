import { describe, expect, it, vi } from 'vitest';
import { JiraProviderAdapter } from './jira';

const issue = {
  id: '10042',
  key: 'PAY-42',
  self: 'https://jira.test/rest/api/3/issue/10042',
  fields: {
    summary: 'Fix checkout',
    status: { name: 'In Progress' },
    updated: '2026-07-22T12:00:00Z',
    description: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'Touches [sayre:file:src/pay.ts] and [sayre:feature:Checkout]',
        }],
      }],
    },
  },
};

describe('JiraProviderAdapter', () => {
  it('fetches and normalizes Jira REST v3 ADF through a loader-supplied token', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(issue), { status: 200 }));
    const loadToken = vi.fn(async () => 'jira-secret-token');
    const adapter = new JiraProviderAdapter(loadToken, fetcher, () => 'https://jira.test/');

    const ticket = await adapter.fetchTicket('PAY-42');

    expect(loadToken).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      'https://jira.test/rest/api/3/issue/PAY-42?fields=summary,status,description,updated',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer jira-secret-token' }),
      }),
    );
    expect(ticket).toEqual(expect.objectContaining({
      provider: 'jira',
      externalId: 'PAY-42',
      status: 'In Progress',
      url: 'https://jira.test/browse/PAY-42',
      references: [
        { kind: 'file', value: 'src/pay.ts' },
        { kind: 'feature', value: 'Checkout' },
      ],
    }));
  });

  it('writes supported fields then refreshes the authoritative issue', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(issue), { status: 200 }));
    const adapter = new JiraProviderAdapter(
      async () => 'token',
      fetcher,
      () => 'https://jira.test',
    );

    await adapter.updateTicket('PAY-42', {
      title: 'Updated title',
      description: 'Updated body',
    });

    const update = fetcher.mock.calls[0];
    expect(update?.[1]).toEqual(expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse(String(update?.[1]?.body))).toEqual({
      fields: {
        summary: 'Updated title',
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'Updated body' }],
          }],
        },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('extracts only Jira issue keys from webhook bodies', () => {
    const adapter = new JiraProviderAdapter();
    expect(adapter.externalIdFromWebhook({ issue: { key: 'PAY-42' } })).toBe('PAY-42');
    expect(adapter.externalIdFromWebhook({ project: { key: 'PAY' } })).toBeNull();
  });
});

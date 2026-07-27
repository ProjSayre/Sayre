import { describe, expect, it, vi } from 'vitest';
import { JiraProviderAdapter, JiraSyncError } from './jira';

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

  // W3-10 edge cases (spec.md "Adapter / worker"): the additive browseBaseUrl
  // param, and the fail-loud default loader now that the global
  // JIRA_ACCESS_TOKEN secret is gone.
  describe('W3-10: per-org base URL split + fail-loud default loader', () => {
    it('calls the API through baseUrl() (the per-org api.atlassian.com gateway) while /browse links use the DISTINCT browseBaseUrl() (the human-facing site URL)', async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(issue), { status: 200 }));
      const adapter = new JiraProviderAdapter(
        async () => 'token',
        fetcher,
        () => 'https://api.atlassian.test/ex/jira/cloud-abc', // API gateway base
        () => 'https://acme.atlassian.net', // human-facing site URL
      );

      const ticket = await adapter.fetchTicket('PAY-42');

      expect(fetcher).toHaveBeenCalledWith(
        'https://api.atlassian.test/ex/jira/cloud-abc/rest/api/3/issue/PAY-42?fields=summary,status,description,updated',
        expect.anything(),
      );
      expect(ticket.url).toBe('https://acme.atlassian.net/browse/PAY-42');
    });

    it('browseBaseUrl defaults to baseUrl when omitted (existing 3-arg callers/tests keep prior behavior)', async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(issue), { status: 200 }));
      const adapter = new JiraProviderAdapter(async () => 'token', fetcher, () => 'https://jira.test');
      const ticket = await adapter.fetchTicket('PAY-42');
      expect(ticket.url).toBe('https://jira.test/browse/PAY-42');
    });

    it('the default loadToken (no loader injected) fails LOUD with JiraSyncError instead of silently reading a removed global secret', async () => {
      const adapter = new JiraProviderAdapter(); // no token loader injected
      await expect(adapter.fetchTicket('PAY-42')).rejects.toBeInstanceOf(JiraSyncError);
      await expect(adapter.fetchTicket('PAY-42')).rejects.toThrow(
        'Jira credentials must be provided per-org; no token loader configured.',
      );
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  disconnectJira,
  fetchJiraIntegrationStatus,
  JiraIntegrationStatusRequestError,
  JiraIntegrationStatusResponseError,
  parseJiraStatusResponse,
} from './jiraIntegrationStatus';

const VALID_CONNECTED_RESPONSE = {
  authorization: 'server-filtered',
  connection: {
    connected: true,
    siteUrl: 'https://acme.atlassian.net',
    siteName: 'Acme',
    connectedByLabel: 'Alex Kwon',
    connectedByAccountId: 'account-1',
    lastSyncedAt: '2026-07-25T14:10:00.000Z',
    connectedAt: '2026-07-20T09:00:00.000Z',
  },
  updatedAt: '2026-07-26T16:00:00.000Z',
};

const VALID_DISCONNECTED_RESPONSE = {
  authorization: 'server-filtered',
  connection: null,
  updatedAt: '2026-07-26T16:00:00.000Z',
};

describe('Jira integration status browser contract', () => {
  it('parses a connected response', () => {
    expect(parseJiraStatusResponse(VALID_CONNECTED_RESPONSE)).toEqual(
      VALID_CONNECTED_RESPONSE,
    );
  });

  it('parses a disconnected (connection: null) response', () => {
    expect(parseJiraStatusResponse(VALID_DISCONNECTED_RESPONSE)).toEqual(
      VALID_DISCONNECTED_RESPONSE,
    );
  });

  it('never exposes a token/cloudId field even if a malicious/misbehaving server included one', () => {
    const withExtraFields = {
      ...VALID_CONNECTED_RESPONSE,
      connection: {
        ...VALID_CONNECTED_RESPONSE.connection,
        accessToken: 'should-never-appear',
        cloudId: 'should-never-appear-either',
      },
    };
    const parsed = parseJiraStatusResponse(withExtraFields);
    expect(parsed.connection).not.toHaveProperty('accessToken');
    expect(parsed.connection).not.toHaveProperty('cloudId');
  });

  it('rejects a malformed authorization discriminant', () => {
    expect(() =>
      parseJiraStatusResponse({ ...VALID_DISCONNECTED_RESPONSE, authorization: 'unfiltered' }),
    ).toThrow(JiraIntegrationStatusResponseError);
  });

  it('rejects a non-boolean `connected` field', () => {
    expect(() =>
      parseJiraStatusResponse({
        ...VALID_CONNECTED_RESPONSE,
        connection: { ...VALID_CONNECTED_RESPONSE.connection, connected: 'yes' },
      }),
    ).toThrow(JiraIntegrationStatusResponseError);
  });

  it('rejects a non-ISO-parseable updatedAt/connectedAt', () => {
    expect(() =>
      parseJiraStatusResponse({ ...VALID_DISCONNECTED_RESPONSE, updatedAt: 'not-a-date' }),
    ).toThrow(JiraIntegrationStatusResponseError);
    expect(() =>
      parseJiraStatusResponse({
        ...VALID_CONNECTED_RESPONSE,
        connection: { ...VALID_CONNECTED_RESPONSE.connection, connectedAt: 'not-a-date' },
      }),
    ).toThrow(JiraIntegrationStatusResponseError);
  });

  it('allows lastSyncedAt: null (never synced yet)', () => {
    const neverSynced = {
      ...VALID_CONNECTED_RESPONSE,
      connection: { ...VALID_CONNECTED_RESPONSE.connection, lastSyncedAt: null },
    };
    expect(parseJiraStatusResponse(neverSynced).connection?.lastSyncedAt).toBeNull();
  });

  it('uses the fixed BFF status route and maps 401/403 to actionable messages', async () => {
    const unauthenticated = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    await expect(fetchJiraIntegrationStatus({ fetchImpl: unauthenticated })).rejects.toEqual(
      new JiraIntegrationStatusRequestError('Sign in to manage the Jira connection.', 401),
    );
    expect(unauthenticated).toHaveBeenCalledWith(
      '/api/core/integrations/jira/status',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );

    const forbidden = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    await expect(fetchJiraIntegrationStatus({ fetchImpl: forbidden })).rejects.toEqual(
      new JiraIntegrationStatusRequestError(
        'Only an organization administrator can manage the Jira connection.',
        403,
      ),
    );
  });

  it('disconnectJira POSTs to the fixed disconnect route and returns the parsed post-disconnect status', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(VALID_DISCONNECTED_RESPONSE), { status: 200 }),
    );
    const result = await disconnectJira({ fetchImpl });
    expect(result).toEqual(VALID_DISCONNECTED_RESPONSE);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/core/integrations/jira/disconnect',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });
});

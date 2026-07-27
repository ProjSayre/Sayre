import { getConfig } from '@sayre/config';
import { parseTicketReferences } from '../references';
import type { NormalizedTicket, TicketProviderAdapter } from '../types';
import type { TicketUpdatePayload } from '../../../queue/bullmq';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type TokenLoader = () => Promise<string>;

export class JiraSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraSyncError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function adfText(value: unknown): string | null {
  if (typeof value === 'string') return stringOrNull(value);
  const node = record(value);
  if (node === null) return null;
  const own = stringOrNull(node.text) ?? '';
  const children = Array.isArray(node.content)
    ? node.content.map(adfText).filter((part): part is string => part !== null)
    : [];
  return stringOrNull([own, ...children].join(' ').replace(/\s+/gu, ' '));
}

function descriptionDocument(description: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
  };
}

function normalizeIssue(value: unknown): NormalizedTicket {
  const issue = record(value);
  const fields = record(issue?.fields);
  const externalId = stringOrNull(issue?.key) ?? stringOrNull(issue?.id);
  const title = stringOrNull(fields?.summary);
  if (issue === null || fields === null || externalId === null || title === null) {
    throw new JiraSyncError('Jira returned an invalid issue response.');
  }
  const description = adfText(fields.description);
  const updatedAt = stringOrNull(fields.updated) ?? new Date().toISOString();
  return {
    provider: 'jira',
    externalId,
    title,
    description,
    status: stringOrNull(record(fields.status)?.name),
    url: stringOrNull(issue.self),
    updatedAt,
    references: parseTicketReferences(description),
    raw: issue,
  };
}

export class JiraProviderAdapter implements TicketProviderAdapter {
  readonly provider = 'jira' as const;

  constructor(
    // W3-10: credentials are per-org now (jira_connections, resolved via
    // getOrgSecret) -- there is no more global JIRA_ACCESS_TOKEN to fall back
    // to. The default loader fails LOUD instead of silently reading a removed
    // secret, so a caller that forgets to inject a per-org loader gets an
    // immediate, unambiguous error rather than a confusing 401 from Jira.
    private readonly loadToken: TokenLoader = () => {
      throw new JiraSyncError(
        'Jira credentials must be provided per-org; no token loader configured.',
      );
    },
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly baseUrl: () => string = () => getConfig('JIRA_BASE_URL'),
    // Additive (W3-10): defaults to `baseUrl` so existing callers/tests that
    // only pass three args keep their current behavior unchanged. The worker
    // now injects `baseUrl` as the per-org api.atlassian.com gateway
    // (`${JIRA_OAUTH_API_BASE_URL}/ex/jira/<cloudId>`) and `browseBaseUrl` as
    // the per-org human-facing site URL, since a 3LO bearer token must call
    // through the gateway base while /browse links need the real site URL.
    private readonly browseBaseUrl: () => string = baseUrl,
  ) {}

  externalIdFromWebhook(payload: unknown): string | null {
    return stringOrNull(record(record(payload)?.issue)?.key);
  }

  async fetchTicket(externalId: string): Promise<NormalizedTicket> {
    const response = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(externalId)}?fields=summary,status,description,updated`,
      { method: 'GET' },
    );
    const ticket = normalizeIssue(await response.json());
    return {
      ...ticket,
      url: `${this.browseBaseUrl().replace(/\/+$/u, '')}/browse/${encodeURIComponent(ticket.externalId)}`,
    };
  }

  async updateTicket(
    externalId: string,
    patch: TicketUpdatePayload,
  ): Promise<NormalizedTicket> {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.description !== undefined) {
      fields.description = descriptionDocument(patch.description);
    }
    if (Object.keys(fields).length === 0) {
      throw new JiraSyncError('Jira update requires a title or description.');
    }
    await this.request(`/rest/api/3/issue/${encodeURIComponent(externalId)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    });
    return this.fetchTicket(externalId);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.loadToken();
    const response = await this.fetcher(
      `${this.baseUrl().replace(/\/+$/u, '')}${path}`,
      {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) {
      throw new JiraSyncError(`Jira issue request returned ${response.status}.`);
    }
    return response;
  }
}

export { adfText, normalizeIssue };

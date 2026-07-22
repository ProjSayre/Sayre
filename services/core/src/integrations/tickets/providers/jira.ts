import { getConfig, getSecret } from '@sayre/config';
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
    private readonly loadToken: TokenLoader = () => getSecret('env://JIRA_ACCESS_TOKEN'),
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly baseUrl: () => string = () => getConfig('JIRA_BASE_URL'),
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
      url: `${this.baseUrl().replace(/\/+$/u, '')}/browse/${encodeURIComponent(ticket.externalId)}`,
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

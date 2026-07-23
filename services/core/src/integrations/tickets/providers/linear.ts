import { getConfig, getSecret } from '@sayre/config';
import type { TicketUpdatePayload } from '../../../queue/bullmq';
import { parseTicketReferences } from '../references';
import type { NormalizedTicket, TicketProviderAdapter } from '../types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type TokenLoader = () => Promise<string>;

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  updatedAt
  state { name }
`;

export const LINEAR_ISSUE_QUERY = `
  query SayreIssue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }
`;

export const LINEAR_ISSUE_UPDATE = `
  mutation SayreIssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { ${ISSUE_FIELDS} }
    }
  }
`;

export class LinearSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearSyncError';
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

function normalizeIssue(value: unknown): NormalizedTicket {
  const issue = record(value);
  const externalId = stringOrNull(issue?.identifier) ?? stringOrNull(issue?.id);
  const title = stringOrNull(issue?.title);
  if (issue === null || externalId === null || title === null) {
    throw new LinearSyncError('Linear returned an invalid issue response.');
  }
  const description = stringOrNull(issue.description);
  return {
    provider: 'linear',
    externalId,
    title,
    description,
    status: stringOrNull(record(issue.state)?.name),
    url: stringOrNull(issue.url),
    updatedAt: stringOrNull(issue.updatedAt) ?? new Date().toISOString(),
    references: parseTicketReferences(description),
    raw: issue,
  };
}

export class LinearProviderAdapter implements TicketProviderAdapter {
  readonly provider = 'linear' as const;

  constructor(
    private readonly loadToken: TokenLoader = () => getSecret('env://LINEAR_ACCESS_TOKEN'),
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly endpoint: () => string = () => getConfig('LINEAR_API_URL'),
  ) {}

  externalIdFromWebhook(payload: unknown): string | null {
    const body = record(payload);
    if (body?.type !== 'Issue') return null;
    const data = record(body.data);
    return stringOrNull(data?.identifier);
  }

  async fetchTicket(externalId: string): Promise<NormalizedTicket> {
    const data = await this.request(LINEAR_ISSUE_QUERY, { id: externalId });
    return normalizeIssue(record(data)?.issue);
  }

  async updateTicket(
    externalId: string,
    patch: TicketUpdatePayload,
  ): Promise<NormalizedTicket> {
    const input: Record<string, string> = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.description !== undefined) input.description = patch.description;
    if (Object.keys(input).length === 0) {
      throw new LinearSyncError('Linear update requires a title or description.');
    }
    const data = await this.request(LINEAR_ISSUE_UPDATE, { id: externalId, input });
    const update = record(record(data)?.issueUpdate);
    if (update?.success !== true) throw new LinearSyncError('Linear issue update failed.');
    return normalizeIssue(update.issue);
  }

  private async request(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const token = await this.loadToken();
    const response = await this.fetcher(this.endpoint(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new LinearSyncError(`Linear GraphQL request returned ${response.status}.`);
    }
    const body = record(await response.json());
    if (body === null || (Array.isArray(body.errors) && body.errors.length > 0)) {
      throw new LinearSyncError('Linear GraphQL request failed.');
    }
    return body.data;
  }
}

export { normalizeIssue };

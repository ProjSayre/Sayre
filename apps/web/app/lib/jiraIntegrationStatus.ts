import { coreFetch } from './coreFetch';

/**
 * Safe projection of a `jira_connections` row toward the browser. This
 * web-local boundary intentionally excludes the access/refresh tokens, the
 * Atlassian cloudId, and any `org_id` echo — mirroring
 * `GitHubIntegrationStatusResponse` discipline.
 */
export interface JiraConnectionStatusView {
  connected: boolean;
  siteUrl: string;
  siteName: string | null;
  connectedByLabel: string;
  connectedByAccountId: string | null;
  lastSyncedAt: string | null;
  connectedAt: string;
}

/**
 * Admin-only, tenant-filtered response expected from Core. Dates serialize as
 * ISO strings over the wire (never `Date` instances here).
 */
export interface JiraStatusResponse {
  authorization: 'server-filtered';
  connection: JiraConnectionStatusView | null;
  updatedAt: string;
}

export interface FetchJiraIntegrationStatusOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class JiraIntegrationStatusResponseError extends Error {
  constructor() {
    super('The Jira integration status response is invalid.');
    this.name = 'JiraIntegrationStatusResponseError';
  }
}

export class JiraIntegrationStatusRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'JiraIntegrationStatusRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JiraIntegrationStatusResponseError();
  }
  return value;
}

function requiredString(value: unknown): string {
  const parsed = stringOrNull(value);
  if (parsed === null) throw new JiraIntegrationStatusResponseError();
  return parsed;
}

function isoDate(value: unknown): string {
  const parsed = requiredString(value);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new JiraIntegrationStatusResponseError();
  }
  return parsed;
}

function isoDateOrNull(value: unknown): string | null {
  if (value === null) return null;
  return isoDate(value);
}

function parseConnection(value: unknown): JiraConnectionStatusView {
  if (!isRecord(value) || typeof value.connected !== 'boolean') {
    throw new JiraIntegrationStatusResponseError();
  }
  return {
    connected: value.connected,
    siteUrl: requiredString(value.siteUrl),
    siteName: stringOrNull(value.siteName),
    connectedByLabel: requiredString(value.connectedByLabel),
    connectedByAccountId: stringOrNull(value.connectedByAccountId),
    lastSyncedAt: isoDateOrNull(value.lastSyncedAt),
    connectedAt: isoDate(value.connectedAt),
  };
}

export function parseJiraStatusResponse(value: unknown): JiraStatusResponse {
  if (!isRecord(value) || value.authorization !== 'server-filtered') {
    throw new JiraIntegrationStatusResponseError();
  }
  if (value.connection !== null && !isRecord(value.connection)) {
    throw new JiraIntegrationStatusResponseError();
  }
  return {
    authorization: 'server-filtered',
    connection:
      value.connection === null ? null : parseConnection(value.connection),
    updatedAt: isoDate(value.updatedAt),
  };
}

function requestError(status: number): JiraIntegrationStatusRequestError {
  if (status === 401) {
    return new JiraIntegrationStatusRequestError(
      'Sign in to manage the Jira connection.',
      status,
    );
  }
  if (status === 403) {
    return new JiraIntegrationStatusRequestError(
      'Only an organization administrator can manage the Jira connection.',
      status,
    );
  }
  return new JiraIntegrationStatusRequestError(
    'Jira connection status could not be loaded.',
    status,
  );
}

async function parseJsonResponse(response: Response): Promise<JiraStatusResponse> {
  if (!response.ok) throw requestError(response.status);
  try {
    return parseJiraStatusResponse(await response.json());
  } catch (error) {
    if (error instanceof JiraIntegrationStatusResponseError) throw error;
    throw new JiraIntegrationStatusResponseError();
  }
}

export async function fetchJiraIntegrationStatus(
  options: FetchJiraIntegrationStatusOptions = {},
): Promise<JiraStatusResponse> {
  const response = await (options.fetchImpl ?? coreFetch)(
    '/api/core/integrations/jira/status',
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal: options.signal,
    },
  );
  return parseJsonResponse(response);
}

export async function disconnectJira(
  options: FetchJiraIntegrationStatusOptions = {},
): Promise<JiraStatusResponse> {
  const response = await (options.fetchImpl ?? coreFetch)(
    '/api/core/integrations/jira/disconnect',
    {
      method: 'POST',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal: options.signal,
    },
  );
  return parseJsonResponse(response);
}

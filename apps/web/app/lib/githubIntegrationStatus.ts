import { coreFetch } from './coreFetch';

export type GitHubInstallationState = 'active' | 'suspended' | 'revoked';

export type GitHubRepositoryImportState = 'preparing' | 'ready' | 'empty';

export interface GitHubInstallationStatus {
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  state: GitHubInstallationState;
  updatedAt: string;
}

export interface GitHubRepositoryImportStatus {
  id: string;
  name: string;
  defaultBranch: string | null;
  currentRef: string | null;
  state: GitHubRepositoryImportState;
  registeredAt: string;
}

/**
 * Admin-only, tenant-filtered response expected from Core. This web-local
 * boundary intentionally excludes installation ids, credentials, queue state,
 * provider errors, and tenant identity.
 */
export interface GitHubIntegrationStatusResponse {
  authorization: 'server-filtered';
  installations: GitHubInstallationStatus[];
  repositories: GitHubRepositoryImportStatus[];
  updatedAt: string;
}

const INSTALLATION_STATES = new Set<GitHubInstallationState>([
  'active',
  'suspended',
  'revoked',
]);
const IMPORT_STATES = new Set<GitHubRepositoryImportState>([
  'preparing',
  'ready',
  'empty',
]);

export interface FetchGitHubIntegrationStatusOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class GitHubIntegrationStatusResponseError extends Error {
  constructor() {
    super('The GitHub integration status response is invalid.');
    this.name = 'GitHubIntegrationStatusResponseError';
  }
}

export class GitHubIntegrationStatusRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'GitHubIntegrationStatusRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GitHubIntegrationStatusResponseError();
  }
  return value;
}

function requiredString(value: unknown): string {
  const parsed = stringOrNull(value);
  if (parsed === null) throw new GitHubIntegrationStatusResponseError();
  return parsed;
}

function isoDate(value: unknown): string {
  const parsed = requiredString(value);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new GitHubIntegrationStatusResponseError();
  }
  return parsed;
}

export function parseGitHubIntegrationStatusResponse(
  value: unknown,
): GitHubIntegrationStatusResponse {
  if (
    !isRecord(value) ||
    value.authorization !== 'server-filtered' ||
    !Array.isArray(value.installations) ||
    !Array.isArray(value.repositories)
  ) {
    throw new GitHubIntegrationStatusResponseError();
  }

  const installations = value.installations.map((item) => {
    if (
      !isRecord(item) ||
      !INSTALLATION_STATES.has(item.state as GitHubInstallationState)
    ) {
      throw new GitHubIntegrationStatusResponseError();
    }
    return {
      accountLogin: stringOrNull(item.accountLogin),
      accountType: stringOrNull(item.accountType),
      repositorySelection: stringOrNull(item.repositorySelection),
      state: item.state as GitHubInstallationState,
      updatedAt: isoDate(item.updatedAt),
    };
  });

  const repositories = value.repositories.map((item) => {
    if (
      !isRecord(item) ||
      !IMPORT_STATES.has(item.state as GitHubRepositoryImportState)
    ) {
      throw new GitHubIntegrationStatusResponseError();
    }
    return {
      id: requiredString(item.id),
      name: requiredString(item.name),
      defaultBranch: stringOrNull(item.defaultBranch),
      currentRef: stringOrNull(item.currentRef),
      state: item.state as GitHubRepositoryImportState,
      registeredAt: isoDate(item.registeredAt),
    };
  });

  if (
    new Set(repositories.map((repository) => repository.id)).size !==
    repositories.length
  ) {
    throw new GitHubIntegrationStatusResponseError();
  }

  return {
    authorization: 'server-filtered',
    installations,
    repositories,
    updatedAt: isoDate(value.updatedAt),
  };
}

function requestError(status: number): GitHubIntegrationStatusRequestError {
  if (status === 401) {
    return new GitHubIntegrationStatusRequestError(
      'Sign in to manage the GitHub connection.',
      status,
    );
  }
  if (status === 403) {
    return new GitHubIntegrationStatusRequestError(
      'Only an organization administrator can manage repository imports.',
      status,
    );
  }
  return new GitHubIntegrationStatusRequestError(
    'GitHub connection status could not be loaded.',
    status,
  );
}

export async function fetchGitHubIntegrationStatus(
  options: FetchGitHubIntegrationStatusOptions = {},
): Promise<GitHubIntegrationStatusResponse> {
  const response = await (options.fetchImpl ?? coreFetch)(
    '/api/core/integrations/github/status',
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal: options.signal,
    },
  );
  if (!response.ok) throw requestError(response.status);
  try {
    return parseGitHubIntegrationStatusResponse(await response.json());
  } catch (error) {
    if (error instanceof GitHubIntegrationStatusResponseError) throw error;
    throw new GitHubIntegrationStatusResponseError();
  }
}

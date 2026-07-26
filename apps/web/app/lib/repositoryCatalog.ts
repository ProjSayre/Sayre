export type RepositoryReadiness = 'registered' | 'graph_ready';

export interface RepositoryCatalogEntry {
  id: string;
  name: string;
  provider: string;
  defaultBranch: string | null;
  currentRef: string | null;
  readiness: RepositoryReadiness;
}

export interface RepositoryCatalogResponse {
  authorization: 'server-filtered';
  repositories: RepositoryCatalogEntry[];
}

export interface FetchRepositoryCatalogOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class RepositoryCatalogResponseError extends Error {
  constructor() {
    super('The repository catalog response is invalid.');
    this.name = 'RepositoryCatalogResponseError';
  }
}

export class RepositoryCatalogRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'RepositoryCatalogRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  options: { allowNull?: boolean } = {},
): string | null {
  if (value === null && options.allowNull) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RepositoryCatalogResponseError();
  }
  return value;
}

export function parseRepositoryCatalogResponse(
  value: unknown,
): RepositoryCatalogResponse {
  if (
    !isRecord(value) ||
    value.authorization !== 'server-filtered' ||
    !Array.isArray(value.repositories)
  ) {
    throw new RepositoryCatalogResponseError();
  }

  const repositories = value.repositories.map((item) => {
    if (!isRecord(item)) throw new RepositoryCatalogResponseError();
    if (
      item.readiness !== 'registered' &&
      item.readiness !== 'graph_ready'
    ) {
      throw new RepositoryCatalogResponseError();
    }
    return {
      id: requiredString(item.id) as string,
      name: requiredString(item.name) as string,
      provider: requiredString(item.provider) as string,
      defaultBranch: requiredString(item.defaultBranch, { allowNull: true }),
      currentRef: requiredString(item.currentRef, { allowNull: true }),
      readiness: item.readiness,
    } satisfies RepositoryCatalogEntry;
  });

  if (
    new Set(repositories.map((repository) => repository.id)).size !==
    repositories.length
  ) {
    throw new RepositoryCatalogResponseError();
  }

  return { authorization: 'server-filtered', repositories };
}

function requestError(status: number): RepositoryCatalogRequestError {
  if (status === 401) {
    return new RepositoryCatalogRequestError(
      'Sign in to view your repositories.',
      status,
    );
  }
  if (status === 403) {
    return new RepositoryCatalogRequestError(
      'You do not have access to this organization.',
      status,
    );
  }
  return new RepositoryCatalogRequestError(
    'The repository catalog could not be loaded.',
    status,
  );
}

export async function fetchRepositoryCatalog(
  options: FetchRepositoryCatalogOptions = {},
): Promise<RepositoryCatalogResponse> {
  const response = await (options.fetchImpl ?? coreFetch)('/api/core/repositories', {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    signal: options.signal,
  });
  if (!response.ok) throw requestError(response.status);
  try {
    return parseRepositoryCatalogResponse(await response.json());
  } catch (error) {
    if (error instanceof RepositoryCatalogResponseError) throw error;
    throw new RepositoryCatalogResponseError();
  }
}
import { coreFetch } from './coreFetch';

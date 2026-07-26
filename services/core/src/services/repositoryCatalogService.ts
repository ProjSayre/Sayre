import type { AuthContext } from '../auth/context';
import {
  repositoryCatalogStore,
  type RepositoryCatalogStore,
  type StoredRepositoryCatalogEntry,
} from '../db/repositoryCatalogStore';
import {
  PostgresPermissionStore,
  canReadResource,
  type AuthorizationRule,
  type PermissionStore,
  type ReadScope,
} from '../graph-query/permissions';

export type RepositoryReadiness = 'registered' | 'graph_ready';

export interface RepositoryCatalogEntry {
  id: string;
  name: string;
  provider: string;
  defaultBranch: string | null;
  currentRef: string | null;
  readiness: RepositoryReadiness;
}

export interface RepositoryCatalog {
  authorization: 'server-filtered';
  repositories: RepositoryCatalogEntry[];
}

export interface RepositoryCatalogServiceDeps {
  store: RepositoryCatalogStore;
  permissions: PermissionStore;
}

const defaultDeps: RepositoryCatalogServiceDeps = {
  store: repositoryCatalogStore,
  permissions: new PostgresPermissionStore(),
};

const MAX_REPOSITORIES = 250;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizedRefName(value: string | null): string | null {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 1_024 ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || code === 127);
    })
  ) {
    return null;
  }
  return normalized.startsWith('refs/')
    ? normalized
    : `refs/heads/${normalized}`;
}

function safeRepository(
  repository: StoredRepositoryCatalogEntry,
): StoredRepositoryCatalogEntry | null {
  const name = repository.name.trim();
  const provider = repository.provider.trim();
  if (
    name.length === 0 ||
    name.length > 512 ||
    !PROVIDER_RE.test(provider)
  ) {
    return null;
  }
  return {
    ...repository,
    name,
    provider,
    defaultBranch: normalizedRefName(repository.defaultBranch)?.replace(
      /^refs\/heads\//,
      '',
    ) ?? null,
    refs: repository.refs.flatMap((ref) => {
      const refName = normalizedRefName(ref.refName);
      return refName === null ? [] : [{ ...ref, refName }];
    }),
  };
}

function ruleAppliesToRepository(
  rule: AuthorizationRule,
  repositoryId: string,
): boolean {
  return rule.repoId === null || rule.repoId === repositoryId;
}

function readableAt(
  scope: ReadScope,
  repositoryId: string,
  refName: string,
): boolean {
  return scope.allows.some((rule) => {
    if (
      !ruleAppliesToRepository(rule, repositoryId) ||
      (rule.branch !== null && rule.branch !== refName)
    ) {
      return false;
    }
    return canReadResource(scope, {
      repoId: repositoryId,
      refName,
      path: rule.pathPrefix ?? '',
    });
  });
}

function repositoryIsVisible(
  scope: ReadScope,
  repository: StoredRepositoryCatalogEntry,
): boolean {
  const knownRefs = repository.refs.map((ref) => ref.refName);
  const defaultRef = normalizedRefName(repository.defaultBranch);
  if (defaultRef !== null) knownRefs.push(defaultRef);

  for (const rule of scope.allows) {
    if (!ruleAppliesToRepository(rule, repository.id)) continue;
    knownRefs.push(rule.branch ?? 'refs/heads/__catalog__');
  }
  return [...new Set(knownRefs)].some((refName) =>
    readableAt(scope, repository.id, refName),
  );
}

function currentAuthorizedRef(
  scope: ReadScope,
  repository: StoredRepositoryCatalogEntry,
): string | null {
  const authorizedRefs = repository.refs.filter((ref) =>
    readableAt(scope, repository.id, ref.refName),
  );
  const defaultRef = normalizedRefName(repository.defaultBranch);
  return (
    authorizedRefs.find((ref) => ref.refName === defaultRef)?.refName ??
    authorizedRefs[0]?.refName ??
    null
  );
}

/**
 * Returns only repositories for which the server-derived auth context has at
 * least one readable resource. No client-supplied tenant identity exists in
 * this API. Ref selection is filtered through the same permission predicate as
 * graph reads, so a branch hidden from the caller cannot become `currentRef`.
 */
export async function getRepositoryCatalog(
  ctx: AuthContext,
  overrides: Partial<RepositoryCatalogServiceDeps> = {},
): Promise<RepositoryCatalog> {
  const deps = { ...defaultDeps, ...overrides };
  const [stored, scope] = await Promise.all([
    deps.store.list(ctx.orgId),
    deps.permissions.getReadScope(ctx),
  ]);

  const repositories = stored
    .flatMap((entry) => {
      const repository = safeRepository(entry);
      if (
        repository === null ||
        !repositoryIsVisible(scope, repository)
      ) {
        return [];
      }
      const currentRef = currentAuthorizedRef(scope, repository);
      return [{
        id: repository.id,
        name: repository.name,
        provider: repository.provider,
        defaultBranch: repository.defaultBranch,
        currentRef,
        readiness: currentRef === null ? 'registered' : 'graph_ready',
      } satisfies RepositoryCatalogEntry];
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    )
    .slice(0, MAX_REPOSITORIES);

  return { authorization: 'server-filtered', repositories };
}

import type { AuthContext } from '../auth/context';
import { getRuntimeDb } from '../db/installations';
import { withOrgContext } from '../db/client';
import {
  repositoryCatalogStore,
  type RepositoryCatalogStore,
  type StoredRepositoryCatalogEntry,
} from '../db/repositoryCatalogStore';
import {
  INSTALLATION_SYNC_STALL_MS,
  listInstallationSyncRows,
  type InstallationSweepOutcome,
  type InstallationSyncRow,
} from '../db/githubInstallationSyncStore';
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

// W7-01: the workspace's partial-sync indicator (AC-11/AC-12).
export type RepositoryImportSyncStatus = 'idle' | 'importing' | 'stalled' | 'failed';

export interface RepositoryImportSync {
  status: RepositoryImportSyncStatus;
  updatedAt: string | null; // ISO-8601, most recent sync row touch
  discoveredRepositories: number | null; // admin/owner only; null for member
  registeredRepositories: number | null; // admin/owner only; null for member
  revokedRepositories: number | null; // admin/owner only; null for member (OQ-4)
  sweepOutcome: InstallationSweepOutcome | null; // admin/owner only; null for member (OQ-4)
}

export interface RepositoryCatalog {
  authorization: 'server-filtered';
  repositories: RepositoryCatalogEntry[];
  sync: RepositoryImportSync;
}

export interface RepositoryCatalogServiceDeps {
  store: RepositoryCatalogStore;
  permissions: PermissionStore;
  syncRows: (orgId: string) => Promise<InstallationSyncRow[]>;
  now: () => Date;
}

const defaultDeps: RepositoryCatalogServiceDeps = {
  store: repositoryCatalogStore,
  permissions: new PostgresPermissionStore(),
  syncRows: async (orgId) =>
    withOrgContext(await getRuntimeDb(), orgId, (tx) => listInstallationSyncRows(tx, orgId)),
  now: () => new Date(),
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
 * Aggregation precedence (AC-11): any pending/running row touched within
 * INSTALLATION_SYNC_STALL_MS -> "importing"; else any pending/running row older than that ->
 * "stalled"; else any failed row -> "failed"; else "idle" (no rows, or all complete/cancelled).
 * Counts, `revokedRepositories` and `sweepOutcome` are non-null only for an admin/owner caller
 * (AC-12, EC-16); `sweepOutcome` reports the most-recently-touched row's outcome, so a withheld
 * mass-revoke is visible to an admin rather than silent.
 */
function summarizeSync(
  rows: InstallationSyncRow[],
  now: Date,
  includeAdminFields: boolean,
): RepositoryImportSync {
  const isStalled = (row: InstallationSyncRow) =>
    now.getTime() - row.updatedAt.getTime() > INSTALLATION_SYNC_STALL_MS;
  const isInFlight = (row: InstallationSyncRow) =>
    row.status === 'pending' || row.status === 'running';

  let status: RepositoryImportSyncStatus = 'idle';
  if (rows.some((row) => isInFlight(row) && !isStalled(row))) {
    status = 'importing';
  } else if (rows.some((row) => isInFlight(row) && isStalled(row))) {
    status = 'stalled';
  } else if (rows.some((row) => row.status === 'failed')) {
    status = 'failed';
  }

  const mostRecent = rows.reduce<InstallationSyncRow | null>(
    (latest, row) => (!latest || row.updatedAt.getTime() > latest.updatedAt.getTime() ? row : latest),
    null,
  );

  return {
    status,
    updatedAt: mostRecent ? mostRecent.updatedAt.toISOString() : null,
    discoveredRepositories: includeAdminFields
      ? rows.reduce((sum, row) => sum + row.discoveredCount, 0)
      : null,
    registeredRepositories: includeAdminFields
      ? rows.reduce((sum, row) => sum + row.registeredCount, 0)
      : null,
    revokedRepositories: includeAdminFields
      ? rows.reduce((sum, row) => sum + row.revokedCount, 0)
      : null,
    sweepOutcome: includeAdminFields ? (mostRecent?.sweepOutcome ?? null) : null,
  };
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
  const [stored, scope, syncRows] = await Promise.all([
    deps.store.list(ctx.orgId),
    deps.permissions.getReadScope(ctx),
    deps.syncRows(ctx.orgId),
  ]);
  const isAdminOrOwner = ctx.roles.includes('admin') || ctx.roles.includes('owner');
  const sync = summarizeSync(syncRows, deps.now(), isAdminOrOwner);

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

  return { authorization: 'server-filtered', repositories, sync };
}

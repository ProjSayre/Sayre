import { and, asc, desc, eq } from 'drizzle-orm';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { repositories, repositoryRefs } from './schema';

export interface StoredRepositoryRef {
  refName: string;
  updatedAt: Date;
}

export interface StoredRepositoryCatalogEntry {
  id: string;
  name: string;
  provider: string;
  defaultBranch: string | null;
  refs: StoredRepositoryRef[];
}

export interface RepositoryCatalogStore {
  list(orgId: string): Promise<StoredRepositoryCatalogEntry[]>;
}

export interface PostgresRepositoryCatalogStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: PostgresRepositoryCatalogStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

/**
 * Read-only tenant catalog. The explicit org predicates are defense in depth;
 * `withOrgContext` also applies the non-owner role and transaction-local RLS
 * context before either table is read.
 */
export class PostgresRepositoryCatalogStore implements RepositoryCatalogStore {
  constructor(
    private readonly deps: PostgresRepositoryCatalogStoreDeps = defaultDeps,
  ) {}

  async list(orgId: string): Promise<StoredRepositoryCatalogEntry[]> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const rows = await tx
        .select({
          id: repositories.id,
          name: repositories.name,
          provider: repositories.provider,
          defaultBranch: repositories.defaultBranch,
          refName: repositoryRefs.refName,
          refUpdatedAt: repositoryRefs.updatedAt,
        })
        .from(repositories)
        .leftJoin(
          repositoryRefs,
          and(
            eq(repositoryRefs.orgId, orgId),
            eq(repositoryRefs.repositoryId, repositories.id),
          ),
        )
        .where(eq(repositories.orgId, orgId))
        .orderBy(
          asc(repositories.name),
          asc(repositories.id),
          desc(repositoryRefs.updatedAt),
          asc(repositoryRefs.refName),
        );

      const catalog = new Map<string, StoredRepositoryCatalogEntry>();
      for (const row of rows) {
        let repository = catalog.get(row.id);
        if (!repository) {
          repository = {
            id: row.id,
            name: row.name,
            provider: row.provider,
            defaultBranch: row.defaultBranch,
            refs: [],
          };
          catalog.set(row.id, repository);
        }
        if (row.refName !== null && row.refUpdatedAt !== null) {
          repository.refs.push({
            refName: row.refName,
            updatedAt: row.refUpdatedAt,
          });
        }
      }
      return [...catalog.values()];
    });
  }
}

export const repositoryCatalogStore: RepositoryCatalogStore =
  new PostgresRepositoryCatalogStore();

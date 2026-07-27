import { and, asc, desc, eq } from 'drizzle-orm';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import {
  githubAppInstallations,
  repositories,
  repositoryRefs,
} from './schema';

export interface StoredGitHubInstallationStatus {
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  suspendedAt: Date | null;
  revokedAt: Date | null;
  updatedAt: Date;
}

export interface StoredGitHubRepositoryRef {
  refName: string;
  updatedAt: Date;
}

export interface StoredGitHubRepositoryStatus {
  id: string;
  name: string;
  defaultBranch: string | null;
  createdAt: Date;
  refs: StoredGitHubRepositoryRef[];
}

export interface StoredGitHubIntegrationStatus {
  installations: StoredGitHubInstallationStatus[];
  repositories: StoredGitHubRepositoryStatus[];
}

export interface GitHubIntegrationStatusStore {
  get(orgId: string): Promise<StoredGitHubIntegrationStatus>;
}

export interface PostgresGitHubIntegrationStatusStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: PostgresGitHubIntegrationStatusStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

/**
 * Tenant-scoped read model for repository onboarding. Explicit org predicates
 * are defense in depth on top of the non-owner role and transaction-local RLS
 * context applied by withOrgContext.
 */
export class PostgresGitHubIntegrationStatusStore
  implements GitHubIntegrationStatusStore
{
  constructor(
    private readonly deps: PostgresGitHubIntegrationStatusStoreDeps = defaultDeps,
  ) {}

  async get(orgId: string): Promise<StoredGitHubIntegrationStatus> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const installationRows = await tx
        .select({
          accountLogin: githubAppInstallations.accountLogin,
          accountType: githubAppInstallations.accountType,
          repositorySelection: githubAppInstallations.repositorySelection,
          suspendedAt: githubAppInstallations.suspendedAt,
          revokedAt: githubAppInstallations.revokedAt,
          updatedAt: githubAppInstallations.updatedAt,
        })
        .from(githubAppInstallations)
        .where(eq(githubAppInstallations.orgId, orgId))
        .orderBy(desc(githubAppInstallations.updatedAt));

      const repositoryRows = await tx
        .select({
          id: repositories.id,
          name: repositories.name,
          defaultBranch: repositories.defaultBranch,
          createdAt: repositories.createdAt,
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
        .where(
          and(
            eq(repositories.orgId, orgId),
            eq(repositories.provider, 'github'),
          ),
        )
        .orderBy(
          asc(repositories.name),
          asc(repositories.id),
          desc(repositoryRefs.updatedAt),
          asc(repositoryRefs.refName),
        );

      const repositoryMap = new Map<string, StoredGitHubRepositoryStatus>();
      for (const row of repositoryRows) {
        let repository = repositoryMap.get(row.id);
        if (!repository) {
          repository = {
            id: row.id,
            name: row.name,
            defaultBranch: row.defaultBranch,
            createdAt: row.createdAt,
            refs: [],
          };
          repositoryMap.set(row.id, repository);
        }
        if (row.refName !== null && row.refUpdatedAt !== null) {
          repository.refs.push({
            refName: row.refName,
            updatedAt: row.refUpdatedAt,
          });
        }
      }

      return {
        installations: installationRows,
        repositories: [...repositoryMap.values()],
      };
    });
  }
}

export const githubIntegrationStatusStore: GitHubIntegrationStatusStore =
  new PostgresGitHubIntegrationStatusStore();

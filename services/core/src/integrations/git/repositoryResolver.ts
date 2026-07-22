import { and, eq } from 'drizzle-orm';
import { getRuntimeDb } from '../../db/installations';
import { withOrgContext, type Db } from '../../db/client';
import { repositories } from '../../db/schema';
import type { ProviderRepoEvent } from './types';

export class GitRepositoryNotRegisteredError extends Error {
  constructor(provider: string, externalId: string) {
    super(`Repository ${provider}:${externalId} is not registered for git synchronization.`);
    this.name = 'GitRepositoryNotRegisteredError';
  }
}

export interface GitRepositoryResolver {
  resolve(orgId: string, event: ProviderRepoEvent): Promise<{ repositoryId: string }>;
}

export class PostgresGitRepositoryResolver implements GitRepositoryResolver {
  constructor(private readonly getDb: () => Promise<Db> = getRuntimeDb) {}

  async resolve(orgId: string, event: ProviderRepoEvent): Promise<{ repositoryId: string }> {
    const db = await this.getDb();
    return withOrgContext(db, orgId, async (transaction) => {
      const rows = await transaction
        .select({ repositoryId: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.orgId, orgId),
            eq(repositories.provider, event.provider),
            eq(repositories.externalId, event.repo.provider_repo_id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new GitRepositoryNotRegisteredError(
          event.provider,
          event.repo.provider_repo_id,
        );
      }
      return row;
    });
  }
}

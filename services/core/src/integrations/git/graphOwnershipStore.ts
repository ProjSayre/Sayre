import { createHash } from 'node:crypto';
import {
  createNeo4jWriteExecutor,
  graphIntegerToNumber,
  type GraphWriteExecutor,
} from '../../graph-write/neo4j';
import type { ProviderFileEdit } from './types';

export interface OwnershipGraphWrite {
  orgId: string;
  provider: string;
  repositoryId: string;
  refName: string;
  edits: ProviderFileEdit[];
}

export interface OwnershipGraphStore {
  apply(input: OwnershipGraphWrite): Promise<{ updatedFiles: number }>;
  close(): Promise<void>;
}

const APPLY_OWNERSHIP_CYPHER = `
UNWIND $edits AS edit
MATCH (file:File {
  org_id: $org_id,
  repo_id: $repo_id,
  ref_name: $ref_name,
  path: edit.path
})
MERGE (person:Person {org_id: $org_id, uid: edit.person_uid})
SET person.name = coalesce(edit.author_name, person.name),
    person.email = coalesce(edit.author_email, person.email),
    person.provider = $provider,
    person.provider_login = coalesce(edit.author_login, person.provider_login),
    person.github_login = CASE
      WHEN $provider = 'github' THEN coalesce(edit.author_login, person.github_login)
      ELSE person.github_login
    END
MERGE (commit:Commit {org_id: $org_id, uid: edit.commit_uid})
SET commit.sha = edit.commit_sha,
    commit.message = edit.commit_message,
    commit.timestamp = edit.edited_at,
    commit.author_name = edit.author_name,
    commit.author_email = edit.author_email,
    commit.provider = $provider,
    commit.repository_id = $repository_id,
    commit.ref_name = $ref_name,
    commit.revision_sha = edit.commit_sha
MERGE (person)-[authored:AUTHORED]->(commit)
SET authored.org_id = $org_id,
    authored.timestamp = edit.edited_at
MERGE (commit)-[modified:MODIFIED]->(file)
SET modified.org_id = $org_id,
    modified.timestamp = edit.edited_at
WITH file, person, edit
OPTIONAL MATCH (previous:Person)-[old_owns:OWNS]->(file)
WHERE old_owns.org_id = $org_id AND previous.uid <> person.uid
DELETE old_owns
MERGE (person)-[owns:OWNS]->(file)
SET owns.org_id = $org_id,
    file.primary_owner_name = coalesce(edit.author_name, file.primary_owner_name),
    file.primary_owner_email = coalesce(edit.author_email, file.primary_owner_email),
    file.primary_owner_provider = $provider,
    file.primary_owner_login = coalesce(edit.author_login, file.primary_owner_login),
    file.last_edited_at = edit.edited_at,
    file.recent_pr_number = coalesce(edit.pr_number, file.recent_pr_number),
    file.recent_pr_title = coalesce(edit.pr_title, file.recent_pr_title),
    file.recent_pr_url = coalesce(edit.pr_url, file.recent_pr_url),
    file.recent_pr_merged_at = coalesce(edit.pr_merged_at, file.recent_pr_merged_at)
RETURN count(DISTINCT file) AS updated_files
`;

function stableUid(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function identityKey(edit: ProviderFileEdit): string | null {
  if (edit.author.login !== null) return `login:${edit.author.login}`;
  if (edit.author.email !== null) return `email:${edit.author.email}`;
  if (edit.author.name !== null) return `name:${edit.author.name}`;
  return null;
}

function graphEdits(input: OwnershipGraphWrite): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const edit of input.edits) {
    const identity = identityKey(edit);
    if (identity === null) continue;
    result.push({
      path: edit.path,
      person_uid: stableUid([
        input.orgId,
        input.provider,
        'Person',
        identity.toLowerCase(),
      ]),
      author_name: edit.author.name,
      author_email: edit.author.email,
      author_login: edit.author.login,
      commit_uid: stableUid([
        input.orgId,
        input.repositoryId,
        input.refName,
        'Commit',
        edit.commitSha,
      ]),
      commit_sha: edit.commitSha,
      commit_message: edit.commitMessage,
      edited_at: edit.editedAt,
      pr_number: edit.pullRequest?.number ?? null,
      pr_title: edit.pullRequest?.title ?? null,
      pr_url: edit.pullRequest?.url ?? null,
      pr_merged_at: edit.pullRequest?.mergedAt ?? null,
    });
  }
  return result;
}

export class Neo4jOwnershipGraphStore implements OwnershipGraphStore {
  constructor(private readonly executor: GraphWriteExecutor) {}

  async apply(input: OwnershipGraphWrite): Promise<{ updatedFiles: number }> {
    const edits = graphEdits(input);
    if (edits.length === 0) return { updatedFiles: 0 };
    const result = await this.executor.run(
      input.orgId,
      APPLY_OWNERSHIP_CYPHER,
      {
        org_id: input.orgId,
        provider: input.provider,
        repo_id: input.repositoryId,
        repository_id: input.repositoryId,
        ref_name: input.refName,
        edits,
      },
      'updated_files',
    );
    const record = result.records[0];
    return {
      updatedFiles: record === undefined ? 0 : graphIntegerToNumber(record.get('updated_files')),
    };
  }

  async close(): Promise<void> {
    await this.executor.close();
  }
}

export async function createOwnershipGraphStore(): Promise<OwnershipGraphStore> {
  return new Neo4jOwnershipGraphStore(await createNeo4jWriteExecutor());
}

export { APPLY_OWNERSHIP_CYPHER };

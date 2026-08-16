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

/**
 * W3-04 gapfill (GAP-1, AC-2). The exact property set APPLY_OWNERSHIP_CYPHER matches a
 * File node on. Must stay identical to the keys the Python ingestion writer sets — see
 * __tests__/crossServiceFileKey.test.ts. A rename on either side must fail that test.
 */
export const OWNERSHIP_FILE_MATCH_KEYS = ['org_id', 'repo_id', 'ref_name', 'path'] as const;

export interface OwnershipApplyResult {
  updatedFiles: number;
  /** W3-04 gapfill (GAP-1b). Distinct paths the write actually matched. Lets the caller
   *  name the paths that did NOT match, instead of only knowing a count. */
  matchedPaths: string[];
}

export interface OwnershipGraphStore {
  apply(input: OwnershipGraphWrite): Promise<OwnershipApplyResult>;
  close(): Promise<void>;
}

/**
 * Two independent UNWIND passes, deliberately not one. The first (`$edits`, one row per
 * edit) writes only append-only historical facts — Person/Commit nodes and AUTHORED/
 * MODIFIED edges — which MERGE makes order-independent across rows, so no two rows ever
 * conflict.
 *
 * The second (`$owner_edits`, at most one row per distinct file path — see
 * `latestEditPerPath` below) owns the OWNS edge and the file's primary_owner_ and
 * recent_pr_ properties, which are current-state (delete-the-old-edge, create-the-new-one), not
 * append-only. An earlier version ran that delete-then-recreate dance inside the
 * per-edit pass: when $edits carried two rows for the same path (two authors editing one
 * file in one batch), Neo4j did not guarantee row 2's OPTIONAL MATCH would see row 1's
 * just-created OWNS edge, so both rows found "no previous owner" and both MERGEd one —
 * reproduced locally against a real Neo4j as a genuine duplicate-edge bug, not a test
 * artifact. Deduplicating to one row per path in JS before this pass removes the
 * conflict structurally (no two rows in `$owner_edits` ever touch the same file's OWNS
 * edge), which is more robust than trying to out-eager Cypher's per-row pipelining for a
 * pattern it re-reads and rewrites on every row.
 */
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
WITH DISTINCT 1 AS _bridge
UNWIND $owner_edits AS owner_edit
MATCH (file:File {
  org_id: $org_id,
  repo_id: $repo_id,
  ref_name: $ref_name,
  path: owner_edit.path
})
MERGE (person:Person {org_id: $org_id, uid: owner_edit.person_uid})
WITH file, person, owner_edit
OPTIONAL MATCH (previous:Person)-[old_owns:OWNS]->(file)
WHERE old_owns.org_id = $org_id AND previous.uid <> person.uid
DELETE old_owns
MERGE (person)-[owns:OWNS]->(file)
SET owns.org_id = $org_id,
    file.primary_owner_name = coalesce(owner_edit.author_name, file.primary_owner_name),
    file.primary_owner_email = coalesce(owner_edit.author_email, file.primary_owner_email),
    file.primary_owner_provider = $provider,
    file.primary_owner_login = coalesce(owner_edit.author_login, file.primary_owner_login),
    file.last_edited_at = owner_edit.edited_at,
    file.recent_pr_number = coalesce(owner_edit.pr_number, file.recent_pr_number),
    file.recent_pr_title = coalesce(owner_edit.pr_title, file.recent_pr_title),
    file.recent_pr_url = coalesce(owner_edit.pr_url, file.recent_pr_url),
    file.recent_pr_merged_at = coalesce(owner_edit.pr_merged_at, file.recent_pr_merged_at)
RETURN count(DISTINCT file) AS updated_files, collect(DISTINCT file.path) AS matched_paths
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

/**
 * One row per distinct `path`, keeping the LAST edit in array order for that path —
 * matches the "last edit wins" semantics the original per-edit `coalesce()` writes
 * already implied, but computed deterministically in JS instead of relying on Cypher's
 * per-row execution order for a delete-then-recreate write (see the doc comment on
 * APPLY_OWNERSHIP_CYPHER above for why that was unsafe).
 */
function latestEditPerPath(edits: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byPath = new Map<string, Record<string, unknown>>();
  for (const edit of edits) byPath.set(edit.path as string, edit);
  return [...byPath.values()];
}

export class Neo4jOwnershipGraphStore implements OwnershipGraphStore {
  constructor(private readonly executor: GraphWriteExecutor) {}

  async apply(input: OwnershipGraphWrite): Promise<OwnershipApplyResult> {
    const edits = graphEdits(input);
    if (edits.length === 0) return { updatedFiles: 0, matchedPaths: [] };
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
        owner_edits: latestEditPerPath(edits),
      },
      'updated_files',
    );
    const record = result.records[0];
    if (record === undefined) return { updatedFiles: 0, matchedPaths: [] };
    const rawMatchedPaths = record.get('matched_paths');
    return {
      updatedFiles: graphIntegerToNumber(record.get('updated_files')),
      matchedPaths: Array.isArray(rawMatchedPaths)
        ? rawMatchedPaths.filter((path): path is string => typeof path === 'string')
        : [],
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

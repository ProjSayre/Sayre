# Audit 06 — Data access layer & schema

Scope: `services/core/src/db/` (18 files), `packages/graph-schema/`, all SQL migrations
(`services/core/drizzle/0000–0018`), plus the Python data-access modules that read/write
those tables (`services/workers/sayre_workers/{db,ingestion,retrieval,tickets,enrichment}`)
and the Neo4j executors, since Cypher injection / session leaks were in scope.

**No SQL or Cypher injection was found.** Every application query is parameterized
(Drizzle `sql` tagged templates or psycopg `%s`), Cypher node labels are interpolated only
from hardcoded tuples (`services/workers/sayre_workers/ingestion/graph.py:218,257,336`),
there is no dynamic ORDER BY / table-name / column-name interpolation outside test files,
and both Neo4j executors close their session in a `finally`
(`services/core/src/graph-query/neo4j.ts:60`, `services/core/src/graph-write/neo4j.ts:53`).
The findings below are correctness, migration-safety, availability, and index problems.

---

### [SEVERITY: HIGH] Retrieval store opens tenant connections without dropping to `sayre_app` — RLS is not engaged on the RAG read path
- **File:** `services/workers/sayre_workers/retrieval/store.py:74-77`
- **Code:**
```python
async def _connect(self, org_id: str) -> psycopg.AsyncConnection[Any]:
    connection = await psycopg.AsyncConnection.connect(self._dsn, row_factory=dict_row)
    await connection.execute("SELECT set_config('app.org_id', %s, false)", (org_id,))
    return connection
```
- **Why it's wrong:** This is the exact defect W2-06 was created to eliminate. `services/workers/sayre_workers/db/session.py` is documented as "the single sanctioned way any worker opens a tenant-scoped Postgres connection" and does three things in order: validate the UUID, `SET LOCAL ROLE sayre_app`, then `set_config(..., true)`. `_connect` does none of them — no UUID validation, **no `SET LOCAL ROLE sayre_app`**, and `is_local=false` (session-scoped, not transaction-local). `docs/tenant-isolation.md:36` lists only `chunks.py`/`state.py` as the Postgres worker paths, so this module was simply missed. Consequence: whenever `DATABASE_RUNTIME_URL` resolves to a superuser/BYPASSRLS role — which is exactly the local/dev posture (`infra/.env.example:31` `POSTGRES_USER=sayre_dev`, and `client.ts:63` documents `sayre_dev` as a superuser) — FORCE RLS is a silent no-op and the only thing standing between tenants on the retrieval path is the hand-written `WHERE chunk.org_id = %s`. `assert_runtime_role_rls_safe` no-ops unless `SAYRE_ENV` is `ci`/`production`, so nothing catches it. One forgotten `org_id` predicate added to either query in `store.py` becomes a cross-tenant RAG leak with no engine backstop.
- **Fix:** Replace `_connect` with `org_scoped_connection(self._dsn, scope.org_id)` (already imported by every other Postgres worker module), and delete `_connect`. Both `load_bounded_chunks` and `load_full_repo_token_count` already fit the `async with` shape.

---

### [SEVERITY: HIGH] `agent_skill_md_versions` immutability trigger blocks every FK cascade — deleting a user, repository, or organization becomes impossible
- **File:** `services/core/drizzle/0010_w4_02_agent_skill_md_versions.sql:9,18,21-23,79-81`
- **Code:**
```sql
org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
...
editor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
...
CONSTRAINT agent_skill_md_versions_org_repository_fk
  FOREIGN KEY (org_id, repo_id) REFERENCES repositories(org_id, id) ON DELETE CASCADE
...
CREATE TRIGGER agent_skill_md_versions_no_update_delete
  BEFORE UPDATE OR DELETE ON agent_skill_md_versions
  FOR EACH ROW EXECUTE FUNCTION agent_skill_md_versions_immutable();
```
- **Why it's wrong:** Referential actions are ordinary UPDATE/DELETE statements and they fire row triggers. `ON DELETE SET NULL` on `editor_user_id` issues `UPDATE agent_skill_md_versions SET editor_user_id = NULL ...`, which hits the BEFORE UPDATE trigger and raises `check_violation`. So: **deleting any user who has ever edited an Agent/Skill MD fails**, and `ON DELETE CASCADE` from `organizations` and `repositories` issues DELETEs that hit the same trigger, so **org deletion and repository deletion fail too** once a single version row exists. This directly contradicts `schema.ts:297` ("Immutable attribution survives account deletion") — account deletion is not survived, it is blocked. The identical bug class was found and patched for `mcp_client_keys` in `0007_rls_triggers_indexes_w0_05_v2.sql:75-94`, then reintroduced here. `agentSkillMdMigration.test.ts` only asserts on the migration's *text*, never executes a delete, so nothing catches it.
- **Fix:** Make the trigger tolerate referential actions. Either (a) restrict it to `BEFORE UPDATE OF <content columns> OR DELETE` and let the `editor_user_id` nulling through, or (b) mirror 0007's pattern: in the trigger function, `RETURN NEW` when `TG_OP = 'UPDATE'` and the only changed column is `editor_user_id` going to NULL; and change the org/repo FKs to `ON DELETE NO ACTION` with an explicit purge routine, or add a `TG_OP = 'DELETE'` allowance when the parent row is gone. Add an integration test that deletes a user, a repo, and an org with version rows present.

---

### [SEVERITY: HIGH] Drizzle meta snapshots stop at 0007 while the journal has 18 entries — the next `db:generate` re-emits `CREATE TABLE` for four live tables
- **File:** `services/core/drizzle/meta/_journal.json` (18 entries) vs `services/core/drizzle/meta/` (only `0000_snapshot.json` … `0007_snapshot.json`); `services/core/package.json:15` `"db:generate": "drizzle-kit generate"`
- **Code:** tables present in `0007_snapshot.json`:
```
code_chunks, code_embeddings, github_app_installations, mcp_client_keys,
model_provider_configs, onboarding_steps, organizations, permissions,
repositories, repository_refs, style_rules, ticket_cache, users
```
- **Why it's wrong:** `drizzle-kit generate` diffs `src/db/schema.ts` against the *latest snapshot*, which here is 0007. Everything added by migrations 0008–0018 is absent from that baseline: `agent_skill_md_versions`, `model_provider_job_states`, `github_initial_parse_outbox`, `jira_connections`, `repositories.revoked_at`, `organizations.mcp_rate_limit_per_minute`, and `ticket_cache.inferred_reference_*`. The next person who adds one column and runs `npm run db:generate` gets a `0019` migration that contains four `CREATE TABLE`s and seven `ADD COLUMN`s for objects that already exist, plus a re-do of the 0008 unique-constraint swap. That migration fails at apply with `relation already exists`, and the natural "fix" (hand-deleting the offending statements, or adding `DROP TABLE IF EXISTS`) is how a production table gets dropped. The migrate path itself (`migrate.ts`, journal-driven) is fine today — only generation is broken, and silently.
- **Fix:** Regenerate the snapshot chain so `meta/` has one snapshot per journal entry (introspect the migrated database with `drizzle-kit introspect`/`pull` and reconcile, or replay 0008–0018 as `--custom` entries with their snapshots committed). Add a CI check asserting `count(meta/*_snapshot.json) == len(_journal.entries)`.

---

### [SEVERITY: HIGH] Migration 0006 adds `NOT NULL` columns with no default and tightens an existing column — it cannot apply to any database that already has rows
- **File:** `services/core/drizzle/0006_w0_05_v2_reshape_and_new_tables.sql:44,48,60`
- **Code:**
```sql
ALTER TABLE "model_provider_configs" ADD COLUMN "purpose" text NOT NULL;
ALTER TABLE "model_provider_configs" ALTER COLUMN "model" SET NOT NULL;
ALTER TABLE "mcp_client_keys" ADD COLUMN "pepper_version" integer NOT NULL;
```
- **Why it's wrong:** `ADD COLUMN ... NOT NULL` without `DEFAULT` fails with `column "purpose" contains null values` the moment the table is non-empty; `ALTER COLUMN "model" SET NOT NULL` fails the same way (`model_provider.default_model` was nullable in `0003_curvy_wolfpack.sql:23`). Any environment that was seeded between 0003 and 0006 — a long-lived dev database, a staging box, an existing customer — is permanently stuck: the migration aborts, Drizzle records nothing, and 0007–0018 never run. There is also **no down migration anywhere in `drizzle/`**, so there is no scripted recovery. The same file does `ALTER TABLE "mcp_client_keys" DROP COLUMN "roles"` (line 58), which is unconditionally destructive with no backfill.
- **Fix:** Split each into the safe three-step form: `ADD COLUMN ... NULL` → `UPDATE ... SET <col> = <backfill>` → `ALTER COLUMN ... SET NOT NULL`. For `purpose`, backfill `'generation'`; for `pepper_version`, backfill `1`. If 0006 is already applied everywhere, add a follow-up migration that is idempotent and leave 0006 alone with a comment — but do not ship the current form to a fresh non-empty environment.

---

### [SEVERITY: HIGH] `pg.Pool` is created with no `error` listener and no limits — an idle-client error takes down the Node process
- **File:** `services/core/src/db/client.ts:21-28`
- **Code:**
```typescript
export function createPool(url: string | undefined): Pool {
  if (!url) { throw new Error("createPool: resolved database URL is not set. ..."); }
  return new Pool({ connectionString: url });
}
```
- **Why it's wrong:** `pg.Pool` extends `EventEmitter` and emits `'error'` when a **checked-in, idle** client's backend connection dies (RDS failover, `idle_in_transaction_session_timeout`, network reset, a `pg_terminate_backend`). Node's EventEmitter rethrows an unhandled `'error'` event as an uncaught exception, so the whole core service exits — node-postgres documents this explicitly. There is no `pool.on('error', ...)` anywhere in the repo. Secondarily, no `max`, `connectionTimeoutMillis`, `idleTimeoutMillis`, or `statement_timeout` is set: the default `max: 10` combined with no `connectionTimeoutMillis` means that under load, checkout requests queue **forever** rather than failing fast, so pool exhaustion presents as an unbounded latency hang instead of a 503.
- **Fix:** In `createPool`, attach `pool.on('error', (err) => logger.error(...))` before returning, and pass explicit `{ max, connectionTimeoutMillis, idleTimeoutMillis, application_name, options: '-c statement_timeout=...' }` from config.

---

### [SEVERITY: MEDIUM] No index matches the hot RBAC predicate on `permissions`; the one composite index that exists matches nothing
- **File:** `services/core/src/graph-query/permissions.ts:343-361` and `:413-432`; indexes in `services/core/drizzle/0000_sleepy_shinobi_shaw.sql:103` and `0002_triggers_and_indexes.sql:83-84`
- **Code:** query predicate —
```typescript
.from(permissions)
.where(and(
  eq(permissions.orgId, ctx.orgId),
  eq(permissions.subjectType, 'agent_key'),
  eq(permissions.subjectId, ctx.agentKeyId),
  inArray(permissions.action, ['read', 'write', 'admin']), ...
```
existing indexes —
```sql
CREATE INDEX "permissions_org_id_idx" ON "permissions" USING btree ("org_id");
CREATE INDEX permissions_org_repo_branch_path_prefix_idx
  ON permissions (org_id, repo_id, branch, path_prefix text_pattern_ops);
```
- **Why it's wrong:** `getReadScope` runs on **every** authorized graph read and MCP call, and issues up to three of these queries per request. Neither index covers `subject_type`/`subject_id`/`action`, so each call degenerates to an index scan on `org_id` followed by a filter over every permission row the org owns. The 0002 index was built for a `path_prefix LIKE 'x%'` scan that no code performs — its comment says "future"; nothing uses it, so the table carries an unused index while the actual workload is unindexed.
- **Fix:** `CREATE INDEX permissions_subject_lookup_idx ON permissions (org_id, subject_type, subject_id, action) INCLUDE (repo_id, branch, path_prefix, effect);` and either drop `permissions_org_repo_branch_path_prefix_idx` or defer it until a query actually uses it.

---

### [SEVERITY: MEDIUM] Filtered vector search: the hnsw index cannot serve the ticket-match query's WHERE clause, so recall collapses as tenants accumulate
- **File:** `services/workers/sayre_workers/tickets/reference_match.py:176-194`; index at `services/core/drizzle/0007_rls_triggers_indexes_w0_05_v2.sql:159-160`
- **Code:**
```sql
SELECT graph_node_id, 1 - (embedding <=> %s::vector) AS similarity
FROM code_embeddings
WHERE org_id = %s AND repository_id = %s AND provider = %s AND model = %s
  AND graph_node_id IS NOT NULL
ORDER BY embedding <=> %s::vector
LIMIT 1
```
against
```sql
CREATE INDEX IF NOT EXISTS code_embeddings_embedding_cosine_idx
  ON code_embeddings USING hnsw (embedding vector_cosine_ops);
```
- **Why it's wrong:** The hnsw index knows nothing about `org_id`/`repository_id`/`provider`/`model`, and the RLS policy adds a further `org_id` predicate. Postgres either (a) uses the hnsw index and post-filters, in which case pgvector returns at most `ef_search` (default 40) candidates *globally* and the tenant/repo filter can eliminate all of them — the ticket silently reports `no_candidates` even though matching vectors exist; or (b) gives up on the index and sequentially scans `code_embeddings`, which is the largest table in the system. Both outcomes are wrong: the first is a silent correctness failure that grows worse with every new tenant, the second is an O(table) scan per ticket sync. There is also no btree covering `(org_id, repository_id, provider, model)` to make (b) tolerable.
- **Fix:** Add `CREATE INDEX code_embeddings_scope_idx ON code_embeddings (org_id, repository_id, provider, model);` and either (i) set `hnsw.iterative_scan = relaxed_order` / raise `hnsw.ef_search` for this query on pgvector ≥ 0.8, or (ii) build partitioned/partial hnsw indexes per repository, or (iii) accept the exact-scan plan and force it with the scope index. Also add a test that asserts a match is still found when another org holds nearer vectors.

---

### [SEVERITY: MEDIUM] `resolve_mcp_client_key` is `SECURITY DEFINER` owned by the migrating superuser, unlike every other pre-tenant resolver
- **File:** `services/core/drizzle/0014_w4_06_mcp_gateway.sql:14-47`
- **Code:**
```sql
CREATE OR REPLACE FUNCTION resolve_mcp_client_key(p_key_prefix text)
RETURNS TABLE (key_id uuid, org_id uuid, key_prefix text, key_hmac text, ...)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$ SELECT ... FROM mcp_client_keys AS key JOIN organizations AS org ... $$;
REVOKE ALL ON FUNCTION resolve_mcp_client_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_mcp_client_key(text) TO sayre_app;
```
- **Why it's wrong:** There is no `ALTER FUNCTION ... OWNER TO`, so the function is owned by whoever ran the migration — `DATABASE_ADMIN_URL`, a superuser in dev. `SECURITY DEFINER` therefore executes this cross-tenant read with **full superuser rights**, and `sayre_app` can invoke it. Migrations `0011` (`sayre_installation_resolver`), `0012` (`sayre_initial_parse_outbox_dispatcher`), and `0017` (`sayre_jira_poll_resolver`) all go to considerable trouble to create a NOLOGIN/NOINHERIT/NOBYPASSRLS owner role, assert it has no memberships, grant it column-level SELECT only, and hand it ownership. 0014 skips all of it, so the narrowest boundary in the design is the widest one in practice. The function body is a bounded single-row read, which is why this is MEDIUM rather than HIGH — but the privilege ceiling is wrong and any future edit to the body inherits superuser.
- **Fix:** Mirror 0011: create `sayre_mcp_key_resolver` (NOLOGIN, NOINHERIT, NOBYPASSRLS), grant it column-level SELECT on `mcp_client_keys(id, org_id, key_prefix, key_hmac, pepper_version, expires_at, revoked_at, created_by)` and `organizations(id, mcp_rate_limit_per_minute)`, add matching `FOR SELECT TO` policies, then `ALTER FUNCTION resolve_mcp_client_key(text) OWNER TO sayre_mcp_key_resolver`.

---

### [SEVERITY: MEDIUM] Three independent `pg.Pool` instances in one process, contradicting the module's own "do not create a second pool" contract
- **File:** `services/core/src/db/installations.ts:60-65`, `services/core/src/graph-query/permissions.ts:44-48`, `services/core/src/services/providerJobStateService.ts:63-68`
- **Code:**
```typescript
// installations.ts
runtimeDbPending = createPoolFromSecret().then((pool) => createDb(pool));
// permissions.ts
defaultDbPromise ??= createPoolFromSecret().then(createDb);
// providerJobStateService.ts
defaultDbPromise ??= createPoolFromSecret().then(createDb);
```
- **Why it's wrong:** `services/core/src/db/authUsers.ts:73` states the contract explicitly — "reuse the SAME memoized runtime db as the install flow, per spec.md (do not create a second pool)". Two later modules each minted their own. At `pg`'s default `max: 10`, one core replica can hold 30 backend connections instead of 10, and each pool resolves the DSN secret separately. Under horizontal scaling this multiplies straight into Postgres `max_connections` exhaustion, and the three pools cannot share a backpressure signal. Compounding it, each memoizes a **promise**: if `createPoolFromSecret()` rejects once (transient secrets-manager blip), the rejected promise is cached permanently and every subsequent request in that process fails forever with the original error — there is no reset path short of a restart.
- **Fix:** Export a single `getRuntimeDb()` from `db/client.ts`, have `permissions.ts` and `providerJobStateService.ts` import it, and null out the memo on rejection (`p.catch(() => { runtimeDbPending = null; })`).

---

### [SEVERITY: MEDIUM] `resolveUserByExternalAuthId` reads `users` cross-tenant with no role drop and no privileged function
- **File:** `services/core/src/db/authUsers.ts:52-60`
- **Code:**
```typescript
const rows = await db
  .select({ userId: users.id, orgId: users.orgId, orgRole: users.orgRole })
  .from(users)
  .where(eq(users.externalAuthId, externalAuthId))
  .limit(1);
```
- **Why it's wrong:** This runs on the pooled runtime connection with **no** `SET LOCAL ROLE sayre_app` and no `app.org_id`, unlike `installations.ts:36-43` and `jiraPollDiscovery.ts:28-34`, which both drop to `sayre_app`, clear the GUC, and call a column-scoped `SECURITY DEFINER` resolver. It works today only because the dev login role is a superuser. In a correctly provisioned production (NOBYPASSRLS login role), RLS returns zero rows, `resolveUserByExternalAuthId` returns `null` on **every** sign-in, and the login flow mints a brand-new organization per login — the exact failure mode the `users_external_auth_id_unique` index in `0013` was added to prevent, except the index will now reject the duplicate insert and every returning user gets a hard 500. The file documents this as a deferred "PRODUCTION GAP", but it is a shipped login path with a known production-breaking behavior.
- **Fix:** Add `resolve_user_by_external_auth_id(text)` as a `SECURITY DEFINER` function owned by a dedicated NOLOGIN/NOBYPASSRLS role returning only `(user_id, org_id, org_role)`, exactly mirroring `0011`, and call it from a `set local role sayre_app` transaction.

---

### [SEVERITY: MEDIUM] Chunk persistence issues one round trip per chunk inside a single long transaction
- **File:** `services/workers/sayre_workers/ingestion/chunks.py:139-172`
- **Code:**
```python
for chunk in chunks:
    cursor = await connection.execute(
        """
        INSERT INTO code_chunks (org_id, repository_id, ref_id, revision_sha, graph_node_id,
             chunk_index, content, content_hash, start_line, end_line, token_count)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (org_id, ref_id, graph_node_id, chunk_index, content_hash)
        DO UPDATE SET ... RETURNING id::text
        """, (...))
    row = await cursor.fetchone()
```
- **Why it's wrong:** `build_bounded_chunks` emits up to `MAX_CHUNKS_PER_FILE = 4` chunks per file, so a 5,000-file repository produces up to 20,000 sequential network round trips, all held inside one open transaction (`async with connection.transaction()`), which pins one Postgres backend and one `code_chunks` write lock set for the whole ingest. This is the classic N+1 write; it also makes the 15-second sync target in the async-messaging rules unreachable for a mid-size repo.
- **Fix:** Batch with `psycopg.cursor.executemany(..., returning=True)` or a single multi-row `INSERT ... VALUES (...), (...) ... RETURNING id, graph_node_id, chunk_index` built from a `psycopg.sql`-composed placeholder list, chunked at ~500 rows per statement.

---

### [SEVERITY: MEDIUM] `code_embeddings` has no `(org_id, ref_id)` index, but every ingest updates the whole ref's embeddings by that predicate
- **File:** `services/workers/sayre_workers/ingestion/chunks.py:132-138`; indexes in `services/core/drizzle/0006_...sql:181` and `0007_...sql:159`
- **Code:**
```python
await connection.execute(
    """
    UPDATE code_embeddings SET revision_sha = %s, updated_at = now()
    WHERE org_id = %s AND ref_id = %s
    """, (scope.revision_sha, scope.org_id, ref_id))
```
- **Why it's wrong:** `code_embeddings` carries only `PRIMARY KEY (id)`, `UNIQUE (chunk_id, provider, model)`, `code_embeddings_org_id_idx (org_id)`, and the hnsw vector index. There is nothing on `ref_id`, so this statement — run once per ingestion, per ref — scans every embedding row the org owns and then filters. On the biggest table in the schema this is the dominant cost of an incremental sync. The `code_chunks` twin (`chunks.py:125-131`) is fine because its unique constraint leads with `(org_id, ref_id, ...)`.
- **Fix:** `CREATE INDEX code_embeddings_org_ref_idx ON code_embeddings (org_id, ref_id);` (this also serves the `DELETE`/cascade path and can be combined with the scope index from the vector-search finding).

---

### [SEVERITY: MEDIUM] `jiraConnectionStore.connect()` update-then-insert races into a raw unique violation
- **File:** `services/core/src/db/jiraConnectionStore.ts:199-218`
- **Code:**
```typescript
const [updated] = await tx.update(jiraConnections).set({...})
  .where(and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)))
  .returning();
if (updated) return toStatusView(updated);

const [inserted] = await tx.insert(jiraConnections).values({ orgId, ...shared }).returning();
```
- **Why it's wrong:** Read-modify-write with no lock and no upsert. Two concurrent OAuth callbacks for an org with no active connection (double-click on "Connect", or a retried callback) both get `updated === undefined`, both fall through to the INSERT, and the partial unique index `jira_connections_active_org_unique` rejects the loser with a bare Postgres 23505 that no caller handles — the user sees a 500 on a flow that should be idempotent. `mcpKeyStore.revoke` (`mcpKeyStore.ts:233-248`) has the same shape but is benign because the `isNull(revokedAt)` guard makes the loser a clean `null`.
- **Fix:** Replace with a single `INSERT ... ON CONFLICT` against the partial unique index (`.onConflictDoUpdate({ target: jiraConnections.orgId, targetWhere: isNull(jiraConnections.revokedAt), set: {...} })`), or take `SELECT ... FOR UPDATE` on the org row first. At minimum, catch 23505 and re-run the update branch.

---

### [SEVERITY: LOW] `vector1024` custom type has no `fromDriver` — `embedding` is typed `number[]` but is actually a string
- **File:** `services/core/src/db/schema.ts:43-50`
- **Code:**
```typescript
const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() { return "vector(1024)"; },
  toDriver(value: number[]): string { return `[${value.join(",")}]`; },
});
```
- **Why it's wrong:** Drizzle applies `fromDriver` on read; with none declared it returns the driver value untouched. pgvector hands back the text literal `'[0.1,0.2,...]'`, so `CodeEmbedding['embedding']` claims `number[]` while holding a `string`. The tests already know this — `rls.test.ts:466` reads it as `res.rows[0].embedding as string`. No production TypeScript reads the column today, so this is latent, but the first consumer that does `embedding.length` or `embedding[0]` gets silently wrong values with no type error.
- **Fix:** Add `fromDriver(value: string): number[] { return JSON.parse(value); }`.

---

### [SEVERITY: LOW] `code_chunks` uniqueness includes a nullable column, so the upsert silently degrades to unbounded inserts if `graph_node_id` is ever null
- **File:** `services/core/drizzle/0008_w1_05_chunk_identity.sql:7-9`; column nullability at `services/core/src/db/schema.ts:616`
- **Code:**
```sql
ALTER TABLE "code_chunks"
  ADD CONSTRAINT "code_chunks_org_ref_node_index_hash_unique"
  UNIQUE("org_id", "ref_id", "graph_node_id", "chunk_index", "content_hash");
```
with `graphNodeId: text("graph_node_id"),` — nullable.
- **Why it's wrong:** PostgreSQL unique constraints default to `NULLS DISTINCT`, so two rows with `graph_node_id IS NULL` never conflict, and `chunks.py`'s `ON CONFLICT (org_id, ref_id, graph_node_id, chunk_index, content_hash) DO UPDATE` would never fire — every re-ingest would append a fresh duplicate row instead of updating. Today `stable_uid` always produces a value so it never triggers, but nothing in the schema enforces that: the column is nullable and the "idempotent re-ingest" guarantee in `schema.ts:629` rests on a convention.
- **Fix:** `ALTER TABLE code_chunks ALTER COLUMN graph_node_id SET NOT NULL;` (or declare the constraint `UNIQUE NULLS NOT DISTINCT` on PG 15+).

---

### [SEVERITY: LOW] `schema.ts` index declarations drift from the migrations that actually built them
- **File:** `services/core/src/db/schema.ts:398-401` vs `services/core/drizzle/0012_github_initial_parse_outbox.sql:59-61`; `schema.ts:316-322` vs `0010_w4_02_agent_skill_md_versions.sql:36-38`
- **Code:**
```typescript
index("github_initial_parse_outbox_due_idx").on(table.nextAttemptAt, table.createdAt),
```
vs
```sql
CREATE INDEX github_initial_parse_outbox_due_idx
  ON github_initial_parse_outbox (next_attempt_at, created_at)
  WHERE delivered_at IS NULL;
```
- **Why it's wrong:** Drizzle has no partial-index builder, so `schema.ts` declares the index without the `WHERE delivered_at IS NULL` predicate (same for `agent_skill_md_versions_latest_idx`, declared ascending but built `version DESC`). Once the snapshot chain is repaired (see the HIGH snapshot finding), `drizzle-kit generate` will see a mismatch and emit `DROP INDEX` + `CREATE INDEX` without the partial clause, quietly converting the outbox dispatcher's partial index into a full one. The partial-index cases that *are* handled correctly (`users_external_auth_id_unique`, `jira_connections_active_org_unique`) are simply omitted from `schema.ts` entirely, which is the right pattern.
- **Fix:** Omit these two index declarations from `schema.ts` (matching the `0013`/`0016` convention) and record the hand-authored DDL in a comment, so drizzle-kit never tries to reconcile them.

---

### [SEVERITY: LOW] Revoking an MCP key leaves its `permissions` grants behind, and `permissions` has no unique constraint to make re-issuance idempotent
- **File:** `services/core/src/db/mcpKeyStore.ts:209-220` (insert) and `:233-248` (revoke); table definition `services/core/src/db/schema.ts:146-173`
- **Code:**
```typescript
await tx.insert(permissions).values(
  input.grants.map((grant) => ({
    orgId, subjectType: 'agent_key', subjectId: input.keyPrefix,
    repoId: grant.repoId, branch: grant.branch, pathPrefix: grant.pathPrefix,
    action: 'read', effect: 'allow',
  })),
);
```
- **Why it's wrong:** `revoke()` sets `revokedAt` on `mcp_client_keys` but never deletes the matching `permissions` rows, so the RBAC system of record accumulates grant rows for dead keys indefinitely — and those rows are what the unindexed `getReadScope` query scans (see the permissions-index finding). `permissions` also has no unique constraint on `(org_id, subject_type, subject_id, repo_id, branch, path_prefix, action)`, so a retried issuance inserts duplicate grants. Not a privilege-escalation risk — `getReadScope` short-circuits on `revokedAt !== null` — but it is unbounded growth on the hottest authorization table.
- **Fix:** Delete the `subject_type='agent_key' AND subject_id=<key_prefix>` rows inside `revoke()`'s transaction, and add a unique constraint (with a `COALESCE`-based expression index or `NULLS NOT DISTINCT`) so grant insertion is idempotent.

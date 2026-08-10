// Drizzle table definitions for the relational system-of-record tables.
//
// The first seven tables are authoritative from W0-05. `mcpClientKeys` and
// `modelProviderConfigs` (originally `modelProvider`) were added as a W0-05
// follow-up, then REDESIGNED by the W0-05 v2 spec (six-table Wave-0
// foundation contract, docs/wave0-foundation-contracts.md "Persistence and
// tenant enforcement") along with four new tables: `githubAppInstallations`,
// `repositoryRefs`, `codeChunks`, `codeEmbeddings`. Downstream tickets may
// add further columns via new migrations. RLS (org_id tenant isolation) is
// enforced by hand-authored raw SQL in drizzle/0001_*_rls_and_role.sql,
// drizzle/0004_rls_and_triggers_mcp_model_provider.sql, and
// drizzle/0007_rls_triggers_indexes_w0_05_v2.sql, NOT expressed here
// (Drizzle's pgTable schema has no first-class RLS-policy builder for this).
//
// Node-level (org/repo/branch/path) RBAC evaluation is explicitly OUT of scope
// here — see .claude/rules/security-multitenancy.md and spec.md "Out" section.
// This file only creates and org-isolates the `permissions` system-of-record
// table; prefix-match authorization logic lives in the Graph Query Service.
// The same applies to the four new tables' `graph_node_id`/`ref` columns:
// cross-store references, never authorization inputs (spec.md "Out").

import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// drizzle-orm 0.38.x has no built-in pgvector type, so declare a `customType`
// that emits `vector(1024)` DDL and (de)serializes the pgvector wire format
// (`'[v1,v2,...]'` text literal). The dimension itself is enforced by
// Postgres/pgvector at write time (a mismatched-length insert is rejected) —
// no separate CHECK constraint needed (see spec.md "code_embeddings").
const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

/** Tenant root. RLS keys on `id` (not `org_id` — organizations IS the org). */
export const organizations = pgTable("organizations", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // W4-06 MCP call budget. It is an org setting rather than a process-only
  // value so administrators can tighten it without redeploying the gateway.
  mcpRateLimitPerMinute: integer("mcp_rate_limit_per_minute")
    .notNull()
    .default(60),
  ...timestamps,
});

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    // Global (cross-tenant) partial-unique index lives in hand-authored raw SQL
    // (drizzle/0013_users_external_auth_id_unique.sql), NOT expressed here —
    // same "physical DDL stays hand-authored" convention as this file's header
    // comment. Deliberately cross-tenant (see AUTH-01 spec.md OQ-1): it race-
    // guards concurrent first-sign-ins for the SAME GitHub identity, which
    // requires uniqueness across rows the runtime role's RLS would otherwise
    // filter out entirely.
    externalAuthId: text("external_auth_id"),
    // Coarse org role ('owner'/'admin'/'member') — NON-authoritative for
    // node-level RBAC (that is the `permissions` table).
    orgRole: text("org_role").notNull().default("member"),
    ...timestamps,
  },
  (table) => [
    unique("users_org_id_email_unique").on(table.orgId, table.email),
    index("users_org_id_idx").on(table.orgId),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("github"),
    externalId: text("external_id"),
    defaultBranch: text("default_branch"),
    // W2-09: set when a repo is removed from the installation
    // (installation_repositories `removed`, or reconcile detecting GitHub no
    // longer reports it). Distinct from graph deletion — graph history is
    // retained. NULL = active. Mirrors github_app_installations.revoked_at
    // (COALESCE-idempotent on redelivery). Re-adding a repo clears this
    // (registerRepository).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("repositories_org_provider_external_unique").on(
      table.orgId,
      table.provider,
      table.externalId,
    ),
    // Supports tenant-consistent composite foreign keys from child tables whose
    // repository id must belong to the same org (W3-08 provider job state).
    unique("repositories_org_id_id_unique").on(table.orgId, table.id),
    index("repositories_org_id_idx").on(table.orgId),
  ],
);

/**
 * System of record for RBAC; scoped by org/repo/branch/path. RLS here is ONLY
 * org_id tenant isolation — path_prefix matching is evaluated later by the
 * Graph Query Service, never by a Postgres policy (see spec.md "Out").
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(), // 'user' | 'team' | 'role'
    subjectId: text("subject_id").notNull(),
    repoId: uuid("repo_id"), // NULL = all repos in org
    branch: text("branch"), // NULL = all branches
    pathPrefix: text("path_prefix"), // NULL = repo root / all paths
    action: text("action").notNull(), // 'read' | 'write' | 'admin'
    effect: text("effect").notNull().default("allow"), // 'allow' | 'deny'
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "permissions_org_repository_fk",
      columns: [table.orgId, table.repoId],
      foreignColumns: [repositories.orgId, repositories.id],
    }).onDelete("cascade"),
    index("permissions_org_id_idx").on(table.orgId),
    // Supports future `path_prefix LIKE 'x%'` prefix scans by the Graph Query
    // Service; the text_pattern_ops opclass variant is added explicitly as raw
    // SQL in 0002 (Drizzle's `text_pattern_ops` opclass support is limited, and
    // the spec calls for this as an explicit hand-authored migration step).
  ],
);

/** Jira/Linear mirror -> graph node reference. */
export const ticketCache = pgTable(
  "ticket_cache",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id"),
    provider: text("provider").notNull(), // 'jira' | 'linear'
    externalTicketId: text("external_ticket_id").notNull(), // e.g. 'PROJ-123'
    title: text("title"),
    status: text("status"),
    url: text("url"),
    // Cross-store reference to a Graph DB node (string key, NOT an FK) —
    // the graph is the source of truth for structural relationships.
    graphNodeId: text("graph_node_id"),
    payload: jsonb("payload"), // raw cached ticket fields
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    // AI-inferred file match (hands-on build, see docs/post-mvp-backlog.md):
    // written by the Python `TicketReferenceMatcher` (embedding similarity
    // search against `code_embeddings`) ONLY when the ticket has no explicit
    // `[sayre:file:...]`/`[sayre:feature:...]` tag. Node's `syncTicket()`
    // merges a non-null `inferredReferenceNodeId` in as a `node_id`
    // `TicketReference` on the NEXT sync cycle before calling `graph.apply()`.
    // A stored value already cleared the Python-side similarity threshold —
    // Node does not re-check `inferredReferenceScore` before using it; the
    // score is retained for observability/debugging only.
    inferredReferenceNodeId: text("inferred_reference_node_id"),
    inferredReferenceScore: real("inferred_reference_score"),
    inferredReferenceComputedAt: timestamp("inferred_reference_computed_at", {
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "ticket_cache_org_repository_fk",
      columns: [table.orgId, table.repoId],
      foreignColumns: [repositories.orgId, repositories.id],
    }).onDelete("cascade"),
    unique("ticket_cache_org_provider_external_unique").on(
      table.orgId,
      table.provider,
      table.externalTicketId,
    ),
    index("ticket_cache_org_id_idx").on(table.orgId),
  ],
);

/** Coding + comment style rules, tracked separately so they diverge independently (PRD §4.9). */
export const styleRules = pgTable(
  "style_rules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id"),
    ruleType: text("rule_type").notNull(), // 'coding_style' | 'comment_style'
    scopeNodeId: text("scope_node_id"), // Graph node id (Folder/File); NULL = repo/org default
    branch: text("branch"),
    pathPrefix: text("path_prefix"), // folder path; inheritance resolved in Graph Query Service
    content: text("content").notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "style_rules_org_repository_fk",
      columns: [table.orgId, table.repoId],
      foreignColumns: [repositories.orgId, repositories.id],
    }).onDelete("cascade"),
    index("style_rules_org_id_idx").on(table.orgId),
  ],
);

/** EnvStep source data; Onboarding Tree = steps ordered by sequence. */
export const onboardingSteps = pgTable(
  "onboarding_steps",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id"),
    branch: text("branch"),
    sequence: integer("sequence").notNull(), // ordering within (repo, branch)
    title: text("title").notNull(),
    body: text("body"),
    command: text("command"), // executable setup command (run later in sandbox)
    graphNodeId: text("graph_node_id"), // link to EnvStep graph node once created
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "onboarding_steps_org_repository_fk",
      columns: [table.orgId, table.repoId],
      foreignColumns: [repositories.orgId, repositories.id],
    }).onDelete("cascade"),
    index("onboarding_steps_org_id_idx").on(table.orgId),
  ],
);

/**
 * Immutable Agent/Skill MD edit history (W4-02).
 *
 * A graph UID identifies the Folder/File presentation node, while the
 * repository/ref/path snapshot makes every version attributable even if a
 * later graph projection removes that node. Reads still authorize the live
 * graph node first; this table is not a parallel authorization source.
 */
export const agentSkillMdVersions = pgTable(
  "agent_skill_md_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").notNull(),
    refName: text("ref_name").notNull(),
    graphNodeId: text("graph_node_id").notNull(),
    nodePath: text("node_path").notNull(),
    nodeLabel: text("node_label").notNull(), // 'Folder' | 'File'
    revisionSha: text("revision_sha").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    editorUserId: uuid("editor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Immutable attribution survives account deletion.
    editorLabel: text("editor_label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.repoId],
      foreignColumns: [repositories.orgId, repositories.id],
      name: "agent_skill_md_versions_org_repository_fk",
    }).onDelete("cascade"),
    unique("agent_skill_md_versions_scope_version_unique").on(
      table.orgId,
      table.repoId,
      table.refName,
      table.graphNodeId,
      table.version,
    ),
    index("agent_skill_md_versions_latest_idx").on(
      table.orgId,
      table.repoId,
      table.refName,
      table.graphNodeId,
      table.version,
    ),
  ],
);

/**
 * GitHub App installation metadata, resolved by the webhook receiver
 * (`installation_id` -> `org_id`, never trusting the payload's org claim) and
 * the App-install/onboarding flow (W1-06). See the RLS chicken-and-egg note
 * in spec.md: the pre-`app.org_id`-context lookup uses a privileged/service
 * path, the same shape as agent-key resolution.
 */
export const githubAppInstallations = pgTable(
  "github_app_installations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // GitHub's numeric installation id. Globally unique — one installation
    // maps to exactly one Sayre org.
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login"),
    accountType: text("account_type"), // 'Organization' | 'User'
    repositorySelection: text("repository_selection"), // 'all' | 'selected'
    // Set when GitHub SUSPENDS the installation. Reversible — GitHub can
    // unsuspend, which clears this back to NULL.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    // Set when the UNINSTALL webhook fires (W1-06). Distinct, non-reversible
    // GitHub App lifecycle event from suspend — only a fresh install (a new
    // `installation_id` row) supersedes a revoked installation. NULL = active.
    // The sync-halt check is `suspended_at IS NULL AND revoked_at IS NULL`.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("github_app_installations_installation_id_unique").on(
      table.installationId,
    ),
    index("github_app_installations_org_id_idx").on(table.orgId),
  ],
);

/**
 * Durable, transactionally-written handoff from the GitHub App callback to
 * the Python ingestion FIFO queue. This table is intentionally specific to
 * `repo.initial_parse`; it is not a general event bus or a replacement for
 * the W0-04 SQS topology.
 *
 * Callback writes use ordinary org-scoped RLS. A narrowly privileged
 * SECURITY DEFINER dispatcher boundary (migration 0012) may lease only due
 * rows and update delivery bookkeeping after the tenant transaction commits.
 */
export const githubInitialParseOutbox = pgTable(
  "github_initial_parse_outbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull().default("repo.initial_parse"),
    idempotencyKey: text("idempotency_key").notNull(),
    envelope: jsonb("envelope").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("github_initial_parse_outbox_org_idempotency_unique").on(
      table.orgId,
      table.idempotencyKey,
    ),
    index("github_initial_parse_outbox_due_idx").on(
      table.nextAttemptAt,
      table.createdAt,
    ),
  ],
);

/**
 * Org-scoped agent API keys (W4-06 issues/resolves; consumed there).
 * Security-sensitive: only a keyed HMAC-SHA-256 digest of the key is ever
 * stored, never the raw secret (see spec.md "Audit-integrity design").
 *
 * Scope convention (no `roles` column): a key's scope is expressed as
 * `permissions` rows with `subject_type = 'agent_key'` and
 * `subject_id = <key_prefix>` — no schema change to `permissions` needed.
 * Issuing/writing those rows, HMAC computation, and pepper management are all
 * the issuance service's job (out of scope here; see spec.md "Out"/O-3).
 *
 * Defect-A fix (cross-org actor): `created_by`/`revoked_by` are guarded by
 * the `mcp_client_keys_same_org_actor()` BEFORE INSERT/UPDATE trigger
 * (drizzle/0007_*), not by a composite FK (which cannot coexist with
 * `ON DELETE SET NULL` on the NOT NULL `org_id` column).
 */
export const mcpClientKeys = pgTable(
  "mcp_client_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Admin-facing label for the settings UI (W4-06).
    name: text("name").notNull(),
    // Public, non-secret lookup identifier (e.g. "mcp_live_ab12cd34"). Globally
    // unique so a presented key resolves to exactly one row before digest compare.
    keyPrefix: text("key_prefix").notNull(),
    // Hex HMAC-SHA-256 digest of the raw 256-bit secret, keyed with a
    // server-held pepper (pepper lives in env/secrets, never in the DB). The
    // raw secret is NEVER stored/logged; returned only once at issuance.
    keyHmac: text("key_hmac").notNull(),
    // Which pepper version produced `key_hmac` — enables pepper rotation
    // without invalidating older rows.
    pepperVersion: integer("pepper_version").notNull(),
    // Issuance sets an expiry; NULL = non-expiring. Enforcement is the auth path.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Audit: who issued the key. Best-effort LIVE pointer — SET NULL (not
    // cascade) so deleting the admin never deletes a still-valid org key.
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Immutable snapshot (e.g. issuing admin's email) captured at issuance;
    // survives user deletion so attribution is never silently erased.
    // Nullable at the DB layer only because issuance is a later ticket — the
    // issuance service MUST populate it (Defect-B fix; see spec.md).
    createdByLabel: text("created_by_label"),
    // Revocation: NULL = active. Soft revoke (row is kept for audit).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Immutable snapshot of the revoking actor (Defect-B fix; see createdByLabel).
    revokedByLabel: text("revoked_by_label"),
    // Audit/metering hook (last successful use). Nullable; enforcement is W4-06.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("mcp_client_keys_key_prefix_unique").on(table.keyPrefix),
    index("mcp_client_keys_org_id_idx").on(table.orgId),
  ],
);

/**
 * Purpose-keyed AI provider/endpoint/credential-reference config: one row per
 * (org, purpose) — 'generation' | 'embedding' — replacing the prior one-row-
 * per-org shape. Consumed by the provider adapters (W3-07/W3-09, purpose =
 * 'generation') and the embedding worker (W1-05, purpose = 'embedding').
 */
export const modelProviderConfigs = pgTable(
  "model_provider_configs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // 'generation' | 'embedding'. Enforced by a CHECK (drizzle/0007_*).
    purpose: text("purpose").notNull(),
    // Adapter selector, e.g. 'anthropic' | 'openai' | 'openai_compatible' | 'voyage'.
    provider: text("provider").notNull(),
    // Endpoint URL for self-hosted / OpenAI-compatible servers.
    // NULL = use the adapter's native SDK default.
    endpointUrl: text("endpoint_url"),
    // REFERENCE to where the real secret lives (env var name / secrets-manager
    // key path), resolved by the W0-07 loader. NEVER a raw credential.
    credentialRef: text("credential_ref"),
    // The selected model id, e.g. 'claude-opus-4', 'Qwen3-Embedding-0.6B'.
    model: text("model").notNull(),
    // For purpose='embedding' rows, the model's output dimension (must be
    // 1024 to match code_embeddings; app-validated, not DB-constrained).
    dimension: integer("dimension"),
    // Adapter-specific options (api version, temperature defaults, etc.).
    config: jsonb("config"),
    ...timestamps,
  },
  (table) => [
    unique("model_provider_configs_org_purpose_unique").on(
      table.orgId,
      table.purpose,
    ),
    // NOTE: do NOT add a separate org_id index — the unique constraint above
    // (leading org_id) already creates the btree index RLS needs.
  ],
);

/**
 * Minimal visible state for provider-backed semantic work. This deliberately has
 * no provider/model/endpoint/prompt/response/error-detail columns: callers may
 * persist only a closed status, a sanitized reason code, scope, and timestamps.
 */
export const modelProviderJobStates = pgTable(
  "model_provider_job_states",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull(),
    refName: text("ref_name").notNull(),
    revisionSha: text("revision_sha").notNull(),
    surface: text("surface").notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code"),
    ...timestamps,
  },
  (table) => [
    unique("model_provider_job_states_org_repo_ref_surface_unique").on(
      table.orgId,
      table.repositoryId,
      table.refName,
      table.surface,
    ),
    foreignKey({
      name: "model_provider_job_states_org_repository_fk",
      columns: [table.orgId, table.repositoryId],
      foreignColumns: [repositories.orgId, repositories.id],
    }).onDelete("cascade"),
    index("model_provider_job_states_scope_updated_idx").on(
      table.orgId,
      table.repositoryId,
      table.refName,
      table.surface,
      table.updatedAt.desc(),
    ),
  ],
);

/**
 * Records each mutable ref's currently accepted revision + graph version, so
 * "a ref maps to exactly one accepted revision, and stale/replayed work
 * cannot move it backward" is enforceable. Columns only — the anti-rollback /
 * ancestor-verification compare-and-set is the ingestion worker's job later.
 */
export const repositoryRefs = pgTable(
  "repository_refs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull(),
    // e.g. 'refs/heads/main' (or 'main').
    refName: text("ref_name").notNull(),
    // The currently accepted HEAD commit SHA. Text (SHA-1 40-hex today,
    // SHA-256 later) — no fixed length.
    revisionSha: text("revision_sha").notNull(),
    // Monotonic counter for optimistic concurrency / anti-rollback; the app
    // compares-and-sets. CHECK graph_version >= 0 (drizzle/0007_*).
    graphVersion: bigint("graph_version", { mode: "number" })
      .notNull()
      .default(0),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "repository_refs_org_repository_fk",
      columns: [table.orgId, table.repositoryId],
      foreignColumns: [repositories.orgId, repositories.id],
    }).onDelete("cascade"),
    unique("repository_refs_org_repo_ref_unique").on(
      table.orgId,
      table.repositoryId,
      table.refName,
    ),
    unique("repository_refs_org_repository_id_unique").on(
      table.orgId,
      table.repositoryId,
      table.id,
    ),
    // NOTE: leading org_id in the unique above covers RLS — no separate index.
  ],
);

/**
 * Bounded, tenant-scoped semantic-chunk storage for RAG (docs/wave0-
 * foundation-contracts.md "Persistence and tenant enforcement"). Holds
 * *chunk* text keyed to a graph node/revision, NOT whole source trees — raw
 * source trees are never persisted; the ingestion scratch clone is destroyed
 * after parse (.claude/rules/security-multitenancy.md). See spec.md O-4.
 */
export const codeChunks = pgTable(
  "code_chunks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull(),
    // Ties the chunk to a (repo, ref) and thus a revision.
    refId: uuid("ref_id").notNull(),
    // Denormalized for provenance/immutability if the ref later advances.
    revisionSha: text("revision_sha").notNull(),
    // Cross-store reference to the File/Function graph node (string key, NOT
    // an FK — the graph is the source of truth), mirroring `ticket_cache.graph_node_id`.
    graphNodeId: text("graph_node_id"),
    // Ordering within the node/file.
    chunkIndex: integer("chunk_index").notNull(),
    // The bounded chunk text.
    content: text("content").notNull(),
    // Hash of `content` for dedup / change detection.
    contentHash: text("content_hash").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    tokenCount: integer("token_count"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "code_chunks_org_repository_ref_fk",
      columns: [table.orgId, table.repositoryId, table.refId],
      foreignColumns: [
        repositoryRefs.orgId,
        repositoryRefs.repositoryId,
        repositoryRefs.id,
      ],
    }).onDelete("cascade"),
    // Idempotent re-ingest; leading org_id covers RLS.
    unique("code_chunks_org_ref_node_index_hash_unique").on(
      table.orgId,
      table.refId,
      table.graphNodeId,
      table.chunkIndex,
      table.contentHash,
    ),
    unique("code_chunks_org_repository_ref_id_unique").on(
      table.orgId,
      table.repositoryId,
      table.refId,
      table.id,
    ),
    // RAG lookups by node (org_id btree already provided by the unique above).
    index("code_chunks_graph_node_id_idx").on(table.graphNodeId),
  ],
);

/**
 * 1024-dim pgvector cosine embeddings, with provider/model/dimension
 * provenance so incompatible vectors are never compared (docs/wave0-
 * foundation-contracts.md). The `vector(1024)` column type is the hard
 * dimension guard — a mismatched-length insert is rejected by pgvector.
 */
export const codeEmbeddings = pgTable(
  "code_embeddings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull(),
    refId: uuid("ref_id").notNull(),
    revisionSha: text("revision_sha").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    // Cross-store node reference (string, not FK).
    graphNodeId: text("graph_node_id"),
    embedding: vector1024("embedding").notNull(),
    // Which provider/model produced the vector.
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // Provenance metadata (the vector column is the hard constraint).
    dimension: integer("dimension").notNull().default(1024),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "code_embeddings_org_repository_ref_chunk_fk",
      columns: [
        table.orgId,
        table.repositoryId,
        table.refId,
        table.chunkId,
      ],
      foreignColumns: [
        codeChunks.orgId,
        codeChunks.repositoryId,
        codeChunks.refId,
        codeChunks.id,
      ],
    }).onDelete("cascade"),
    // One embedding per chunk per provider/model.
    unique("code_embeddings_chunk_provider_model_unique").on(
      table.chunkId,
      table.provider,
      table.model,
    ),
    index("code_embeddings_org_id_idx").on(table.orgId),
    // hnsw cosine index is authored as raw SQL in drizzle/0007_* (Drizzle has
    // no first-class opclass/access-method builder for this).
  ],
);

/**
 * Per-org Jira Cloud OAuth 3LO connection (W3-10). At most one ACTIVE
 * (`revoked_at IS NULL`) row per org — enforced by a hand-authored partial
 * unique index (drizzle/0016_jira_connections.sql; Drizzle's schema builder
 * has no first-class partial-index support, same convention as
 * `users_external_auth_id_unique` in drizzle/0013_*), not expressed here.
 *
 * Security-sensitive: `jiraAccessTokenEnc` / `jiraRefreshTokenEnc` hold
 * AES-256-GCM ciphertext (`integrations/tickets/jira/jiraTokenCipher.ts`,
 * OQ-2) and are read/written ONLY by `db/jiraConnectionStore.ts` and
 * `integrations/tickets/jira/orgSecrets.ts` (plus this definition site) —
 * enforced by `scripts/check-org-secret-access.mjs` in CI. Every other
 * consumer resolves credentials through `getOrgSecret` /
 * `resolveJiraConnectionContext`, never this table directly.
 *
 * Disconnect is a soft-revoke (`revokedAt`/`revokedBy`/`revokedByLabel` set,
 * and BOTH `*Enc` columns nulled to shrink the at-rest blast radius) — the
 * row is retained for audit, mirroring `mcpClientKeys`.
 */
export const jiraConnections = pgTable(
  "jira_connections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Atlassian cloudId. The per-org API gateway base is
    // `${JIRA_OAUTH_API_BASE_URL}/ex/jira/<cloudId>` — never rendered to the
    // browser (JiraConnectionStatusView omits both this and the tokens).
    cloudId: text("cloud_id").notNull(),
    // Human-facing site URL (https://<tenant>.atlassian.net) — used only for
    // /browse links and Settings display, never as an API call base.
    siteUrl: text("site_url").notNull(),
    siteName: text("site_name"),
    // AES-256-GCM ciphertext ("v1:<ivB64>:<tagB64>:<ctB64>"). NULL once
    // revoked (soft-revoke nulls both *Enc columns).
    jiraAccessTokenEnc: text("jira_access_token_enc"),
    jiraRefreshTokenEnc: text("jira_refresh_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    scopes: text("scopes"),
    // Attribution: best-effort LIVE pointer (SET NULL, not cascade — deleting
    // the connecting admin never deletes the still-active connection) plus an
    // immutable label snapshot captured at connect time, mirroring
    // mcpClientKeys.createdBy / createdByLabel.
    connectedByUserId: uuid("connected_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    connectedByLabel: text("connected_by_label").notNull(),
    // Jira's own accountId for the connecting user (JiraOAuthUser.accountId) —
    // non-secret metadata kept for support/audit; never an authorization input.
    connectedByAccountId: text("connected_by_account_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft-revoke (disconnect). NULL = active.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedByLabel: text("revoked_by_label"),
    ...timestamps,
  },
  (table) => [
    // RLS/lookup index over ALL rows (active + revoked); the partial unique
    // index over only active rows is a SEPARATE hand-authored index (see
    // drizzle/0016_jira_connections.sql) and does not cover revoked rows.
    index("jira_connections_org_id_idx").on(table.orgId),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type TicketCache = typeof ticketCache.$inferSelect;
export type NewTicketCache = typeof ticketCache.$inferInsert;
export type StyleRule = typeof styleRules.$inferSelect;
export type NewStyleRule = typeof styleRules.$inferInsert;
export type OnboardingStep = typeof onboardingSteps.$inferSelect;
export type NewOnboardingStep = typeof onboardingSteps.$inferInsert;
export type AgentSkillMdVersion = typeof agentSkillMdVersions.$inferSelect;
export type NewAgentSkillMdVersion = typeof agentSkillMdVersions.$inferInsert;
export type GithubAppInstallation = typeof githubAppInstallations.$inferSelect;
export type NewGithubAppInstallation = typeof githubAppInstallations.$inferInsert;
export type GithubInitialParseOutbox = typeof githubInitialParseOutbox.$inferSelect;
export type NewGithubInitialParseOutbox = typeof githubInitialParseOutbox.$inferInsert;
export type McpClientKey = typeof mcpClientKeys.$inferSelect;
export type NewMcpClientKey = typeof mcpClientKeys.$inferInsert;
export type ModelProviderConfig = typeof modelProviderConfigs.$inferSelect;
export type NewModelProviderConfig = typeof modelProviderConfigs.$inferInsert;
export type ModelProviderJobState = typeof modelProviderJobStates.$inferSelect;
export type NewModelProviderJobState = typeof modelProviderJobStates.$inferInsert;
export type RepositoryRef = typeof repositoryRefs.$inferSelect;
export type NewRepositoryRef = typeof repositoryRefs.$inferInsert;
export type CodeChunk = typeof codeChunks.$inferSelect;
export type NewCodeChunk = typeof codeChunks.$inferInsert;
export type CodeEmbedding = typeof codeEmbeddings.$inferSelect;
export type NewCodeEmbedding = typeof codeEmbeddings.$inferInsert;
export type JiraConnection = typeof jiraConnections.$inferSelect;
export type NewJiraConnection = typeof jiraConnections.$inferInsert;

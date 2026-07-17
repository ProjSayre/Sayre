// Drizzle table definitions for the relational system-of-record tables.
//
// The first seven tables are authoritative from W0-05; `mcpClientKeys` and
// `modelProvider` were added as a W0-05 follow-up (see spec.md in that
// ticket's .pipeline/ run) to unblock W4-06/W3-07. Downstream tickets may add
// further columns via new migrations. RLS (org_id tenant isolation) is
// enforced by hand-authored raw SQL in drizzle/0001_*_rls_and_role.sql and
// drizzle/0004_rls_and_triggers_mcp_model_provider.sql, NOT expressed here
// (Drizzle's pgTable schema has no first-class RLS-policy builder for this).
//
// Node-level (org/repo/branch/path) RBAC evaluation is explicitly OUT of scope
// here — see .claude/rules/security-multitenancy.md and spec.md "Out" section.
// This file only creates and org-isolates the `permissions` system-of-record
// table; prefix-match authorization logic lives in the Graph Query Service.

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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
    ...timestamps,
  },
  (table) => [
    unique("repositories_org_provider_external_unique").on(
      table.orgId,
      table.provider,
      table.externalId,
    ),
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
    repoId: uuid("repo_id").references(() => repositories.id, {
      onDelete: "cascade",
    }), // NULL = all repos in org
    branch: text("branch"), // NULL = all branches
    pathPrefix: text("path_prefix"), // NULL = repo root / all paths
    action: text("action").notNull(), // 'read' | 'write' | 'admin'
    effect: text("effect").notNull().default("allow"), // 'allow' | 'deny'
    ...timestamps,
  },
  (table) => [
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
    repoId: uuid("repo_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
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
    ...timestamps,
  },
  (table) => [
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
    repoId: uuid("repo_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    ruleType: text("rule_type").notNull(), // 'coding_style' | 'comment_style'
    scopeNodeId: text("scope_node_id"), // Graph node id (Folder/File); NULL = repo/org default
    branch: text("branch"),
    pathPrefix: text("path_prefix"), // folder path; inheritance resolved in Graph Query Service
    content: text("content").notNull(),
    ...timestamps,
  },
  (table) => [index("style_rules_org_id_idx").on(table.orgId)],
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
    repoId: uuid("repo_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    branch: text("branch"),
    sequence: integer("sequence").notNull(), // ordering within (repo, branch)
    title: text("title").notNull(),
    body: text("body"),
    command: text("command"), // executable setup command (run later in sandbox)
    graphNodeId: text("graph_node_id"), // link to EnvStep graph node once created
    ...timestamps,
  },
  (table) => [index("onboarding_steps_org_id_idx").on(table.orgId)],
);

/**
 * Org-scoped agent API keys (W4-06 issues/resolves; consumed there). Security-
 * sensitive: only a hash of the key is ever stored, never the raw secret.
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
    // unique so a presented key resolves to exactly one row before hash compare.
    keyPrefix: text("key_prefix").notNull(),
    // SHA-256 hex digest of the raw key. The raw key is NEVER stored/logged.
    // (API keys are high-entropy random secrets, so a fast crypto hash is the
    // standard choice — not a password KDF. Hashing itself is W4-06.)
    keyHash: text("key_hash").notNull(),
    // Scope: the `roles` half of the { orgId, roles } context shape (W1-03).
    // Array of role strings; exact vocabulary is W1-03/W4-06's (see spec O-2).
    roles: jsonb("roles").notNull().default(sql`'[]'::jsonb`),
    // Audit: who issued the key. SET NULL (not cascade) — deleting the admin
    // must not delete a still-valid org key.
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Revocation: NULL = active. Soft revoke (row is kept for audit).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
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
 * Per-org AI provider/endpoint/credential-reference config (consumed by
 * W3-07). One row per org (unique on org_id) — see spec O-1.
 */
export const modelProvider = pgTable(
  "model_provider",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Selects which W3-07 adapter runs: 'anthropic' | 'openai' | 'openai_compatible'.
    providerType: text("provider_type").notNull(),
    // Endpoint URL for self-hosted / OpenAI-compatible servers.
    // NULL = use the adapter's native SDK default (Anthropic/OpenAI hosted).
    endpointUrl: text("endpoint_url"),
    // REFERENCE to where the real secret lives (env var name / secrets-manager
    // key path), resolved by the W0-07 loader. NEVER a raw credential.
    // NULL = endpoint needs no credential (e.g. unauthenticated local server).
    credentialRef: text("credential_ref"),
    // Default model id for this provider (e.g. 'claude-opus-4', 'llama-3.1-70b').
    defaultModel: text("default_model"),
    // Adapter-specific options (api version, temperature defaults, etc.).
    config: jsonb("config"),
    ...timestamps,
  },
  (table) => [
    unique("model_provider_org_id_unique").on(table.orgId),
    // NOTE: do NOT add a separate org_id index — the unique constraint above
    // already creates the btree index RLS needs (mirrors how `organizations`
    // keys RLS on its already-indexed PK and adds no redundant index).
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
export type McpClientKey = typeof mcpClientKeys.$inferSelect;
export type NewMcpClientKey = typeof mcpClientKeys.$inferInsert;
export type ModelProvider = typeof modelProvider.$inferSelect;
export type NewModelProvider = typeof modelProvider.$inferInsert;

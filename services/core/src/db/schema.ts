// Drizzle table definitions for the seven relational system-of-record tables.
//
// Column list here is authoritative for this ticket (W0-05); downstream tickets
// may add columns via new migrations. RLS (org_id tenant isolation) is enforced
// by hand-authored raw SQL in drizzle/0001_*_rls_and_role.sql, NOT expressed here
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

-- Custom SQL migration file, put your code below! --

-- W3-10: per-org Jira Cloud OAuth 3LO connection. Hand-authored (drizzle-kit
-- generate --custom) because it bundles the CREATE TABLE together with its
-- RLS/trigger/index follow-up in one migration, rather than the two-step
-- 0006/0007 split used for the W0-05 v2 tables -- there is only one new table
-- here, so there is no risk of drifting the base table from its RLS shape in
-- the interim.
--
-- Mirrors: `mcp_client_keys`' org_isolation RLS policy + FORCE RLS + grant
-- idiom (drizzle/0004_*), the `updated_at` trigger idiom (trigger_set_updated_at()
-- defined once in 0002_triggers_and_indexes.sql, reused here, same as every
-- other migration since), and `users_external_auth_id_unique`'s hand-authored
-- partial-unique-index idiom (drizzle/0013_*) for "at most one ACTIVE
-- (revoked_at IS NULL) row per org" -- Drizzle's schema builder has no
-- first-class partial-index support (see schema.ts's jiraConnections comment).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE "jira_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cloud_id" text NOT NULL,
	"site_url" text NOT NULL,
	"site_name" text,
	"jira_access_token_enc" text,
	"jira_refresh_token_enc" text,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text,
	"connected_by_user_id" uuid,
	"connected_by_label" text NOT NULL,
	"connected_by_account_id" text,
	"last_synced_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint

ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

--> statement-breakpoint

ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Indexes: ordinary org_id index (all rows -- RLS/lookup) + the partial
-- unique index enforcing "at most one active connection per org" (only
-- revoked_at IS NULL rows participate; a reconnect overwrites that same row
-- rather than colliding -- see jiraConnectionStore.connect()).
-- ---------------------------------------------------------------------------
CREATE INDEX "jira_connections_org_id_idx" ON "jira_connections" ("org_id");

--> statement-breakpoint

CREATE UNIQUE INDEX "jira_connections_active_org_unique"
  ON "jira_connections" ("org_id")
  WHERE "revoked_at" IS NULL;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS: ENABLE + FORCE + org_isolation policy, same idiom as every other
-- tenant-scoped table (drizzle/0001_*, 0004_*, 0007_*).
-- ---------------------------------------------------------------------------
ALTER TABLE jira_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE jira_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON jira_connections
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuse trigger_set_updated_at() defined in 0002).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON jira_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON jira_connections
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Explicit least-privilege grant (idempotent belt-and-suspenders; 0001's
-- ALTER DEFAULT PRIVILEGES should already cover it -- same rationale as
-- every other migration's matching grant).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON jira_connections TO sayre_app;

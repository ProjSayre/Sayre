-- Custom SQL migration file, put your code below! --

-- CH-03: durable spine for "Ask Sayre" — chat_conversations + chat_turns, with
-- RLS/trigger/grant follow-up bundled into this one migration, same as
-- drizzle/0016_jira_connections.sql (one new pair of tables, no risk of
-- drifting the base tables from their RLS shape in the interim).
--
-- Mirrors: `jira_connections`' org_isolation RLS + FORCE RLS + grant idiom
-- (drizzle/0016_*), the `updated_at` trigger idiom (trigger_set_updated_at()
-- defined once in 0002_triggers_and_indexes.sql, reused here), and
-- `model_provider_job_states`/`agent_skill_md_versions`'s tenant-consistent
-- composite-FK idiom for a child row whose owner must belong to the same org.
--
-- A user turn is always already `completed` (it is the caller's own text,
-- persisted synchronously); its paired assistant turn starts `pending` and is
-- transitioned by CH-04. `chat_turns_user_shape_check` /
-- `chat_turns_assistant_shape_check` make that pairing structurally
-- impossible to get wrong at the database layer, not just by convention.

-- ---------------------------------------------------------------------------
-- chat_conversations
-- ---------------------------------------------------------------------------
CREATE TABLE "chat_conversations" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"     uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "title"      text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT chat_conversations_title_check
    CHECK (title IS NULL OR (length(btrim(title)) > 0 AND length(title) <= 200))
);

--> statement-breakpoint

-- Enables the tenant-consistent composite FK below. Mirrors
-- `repositories_org_id_id_unique` (schema.ts), added for the same reason.
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_id_unique" UNIQUE ("org_id","id");

--> statement-breakpoint

ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;

--> statement-breakpoint

ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_org_user_fk"
  FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE cascade;

--> statement-breakpoint

ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_org_id_id_unique"
  UNIQUE ("org_id","id");

--> statement-breakpoint

CREATE INDEX "chat_conversations_owner_recent_idx"
  ON "chat_conversations" ("org_id","user_id","updated_at" DESC);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- chat_turns
-- ---------------------------------------------------------------------------
CREATE TABLE "chat_turns" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"          uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "seq"             integer NOT NULL,
  "role"            text NOT NULL,
  "content"         text NOT NULL,
  "status"          text NOT NULL,
  "citations"       jsonb,
  "metrics"         jsonb,
  "error"           jsonb,
  "scope"           jsonb,
  "idempotency_key" text,
  "request_turn_id" uuid,
  "dispatched_at"   timestamp with time zone,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT chat_turns_role_check   CHECK (role IN ('user','assistant')),
  CONSTRAINT chat_turns_status_check CHECK (status IN ('pending','running','completed','error')),
  CONSTRAINT chat_turns_seq_check    CHECK (seq >= 1),
  CONSTRAINT chat_turns_user_shape_check CHECK (
    role <> 'user' OR (
      idempotency_key IS NOT NULL AND request_turn_id IS NULL
      AND status = 'completed' AND length(btrim(content)) > 0
      AND dispatched_at IS NULL
    )
  ),
  CONSTRAINT chat_turns_assistant_shape_check CHECK (
    role <> 'assistant' OR (idempotency_key IS NULL AND request_turn_id IS NOT NULL)
  ),
  CONSTRAINT chat_turns_error_status_check CHECK (error IS NULL OR status = 'error'),
  CONSTRAINT chat_turns_citations_check CHECK (citations IS NULL OR jsonb_typeof(citations) = 'array'),
  CONSTRAINT chat_turns_metrics_check  CHECK (metrics IS NULL OR jsonb_typeof(metrics) = 'object'),
  CONSTRAINT chat_turns_error_object_check CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT chat_turns_scope_check CHECK (
    scope IS NULL OR (
      jsonb_typeof(scope) = 'object'
      AND (scope->'view' = 'null'::jsonb
           OR scope->>'view' IN ('technical','product','onboarding'))
      AND (scope->'anchorNodeId' = 'null'::jsonb
           OR jsonb_typeof(scope->'anchorNodeId') = 'string')
    )
  )
);

--> statement-breakpoint

ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_org_conversation_fk"
  FOREIGN KEY ("org_id","conversation_id")
  REFERENCES "public"."chat_conversations"("org_id","id") ON DELETE cascade;

--> statement-breakpoint

ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_request_turn_id_fk"
  FOREIGN KEY ("request_turn_id") REFERENCES "public"."chat_turns"("id") ON DELETE cascade;

--> statement-breakpoint

ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_org_conversation_seq_unique"
  UNIQUE ("org_id","conversation_id","seq");

--> statement-breakpoint

-- The AC-2 idempotency guard. Partial because only user turns carry a key.
CREATE UNIQUE INDEX "chat_turns_idempotency_unique"
  ON "chat_turns" ("org_id","conversation_id","idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

--> statement-breakpoint

-- At most one assistant turn per user turn — makes a double-insert of the
-- pending answer structurally impossible, not merely unlikely.
CREATE UNIQUE INDEX "chat_turns_request_turn_unique"
  ON "chat_turns" ("org_id","request_turn_id")
  WHERE "request_turn_id" IS NOT NULL;

--> statement-breakpoint

-- chat_turns deliberately gets NO standalone org_id index: the leading org_id
-- of chat_turns_org_conversation_seq_unique already provides the btree RLS
-- needs (the same note as model_provider_configs / repository_refs in
-- schema.ts).

-- ---------------------------------------------------------------------------
-- RLS: ENABLE + FORCE + org_isolation policy on both tables, same idiom as
-- every other tenant-scoped table (drizzle/0001_*, 0004_*, 0016_*).
-- ---------------------------------------------------------------------------
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON chat_conversations
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON chat_turns
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuse trigger_set_updated_at() defined in 0002).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON chat_conversations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON chat_turns;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON chat_turns
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Explicit least-privilege grants. No DELETE: v1 has no delete operation on
-- either table (spec.md "Out").
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON chat_conversations TO sayre_app;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON chat_turns TO sayre_app;

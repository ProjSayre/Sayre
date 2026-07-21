-- Custom SQL migration file, put your code below! --

-- Hand-authored raw SQL (drizzle-kit generate --custom).
--
-- Table DDL for the W0-05 v2 six-table reshape/expansion
-- (docs/wave0-foundation-contracts.md "Persistence and tenant enforcement").
-- Authored by hand rather than via `drizzle-kit generate`'s interactive
-- rename-detection TUI, which is not reliably scriptable in this runner (see
-- spec.md "Approach" step 3: "If drizzle-kit's rename detection is unreliable
-- in the runner, hand-author the equivalent ALTERs as a custom migration
-- instead — the target DDL is fully specified above."). Content matches the
-- exact column lists in spec.md "Interfaces / signatures" and mirrors
-- drizzle-kit's own generated-DDL idioms (double-quoted identifiers,
-- statement-breakpoints, `ADD CONSTRAINT ... FOREIGN KEY` phrasing) so it's
-- indistinguishable from a generated migration at apply time.
--
-- RLS (ENABLE/FORCE/policy), CHECK constraints, the same-org-actor trigger,
-- updated_at triggers, the hnsw index, and sayre_app grants are all in
-- 0007_rls_triggers_indexes_w0_05_v2.sql — NOT here (this file is DDL shape
-- only, matching the 0001/0002 vs 0000 split idiom already used in this repo).
--
-- Answers to drizzle-kit's rename prompts, transcribed as hand-authored SQL:
--   model_provider          -> RENAME TO model_provider_configs
--   model_provider.provider_type -> RENAME COLUMN TO provider
--   model_provider.default_model -> RENAME COLUMN TO model
--   mcp_client_keys.key_hash     -> RENAME COLUMN TO key_hmac
--   mcp_client_keys.roles        -> DROP COLUMN (replaced by the `permissions`
--     subject_type='agent_key' convention — see schema.ts's mcpClientKeys doc
--     comment; no schema change to `permissions` needed)

-- ---------------------------------------------------------------------------
-- model_provider -> model_provider_configs (rename + reshape)
-- ---------------------------------------------------------------------------
ALTER TABLE "model_provider" RENAME TO "model_provider_configs";
--> statement-breakpoint
ALTER TABLE "model_provider_configs" RENAME CONSTRAINT "model_provider_org_id_organizations_id_fk" TO "model_provider_configs_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "model_provider_configs" RENAME COLUMN "provider_type" TO "provider";
--> statement-breakpoint
ALTER TABLE "model_provider_configs" RENAME COLUMN "default_model" TO "model";
--> statement-breakpoint
ALTER TABLE "model_provider_configs" DROP CONSTRAINT "model_provider_org_id_unique";
--> statement-breakpoint
ALTER TABLE "model_provider_configs" ADD COLUMN "purpose" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_provider_configs" ADD COLUMN "dimension" integer;
--> statement-breakpoint
ALTER TABLE "model_provider_configs" ALTER COLUMN "model" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_provider_configs" ADD CONSTRAINT "model_provider_configs_org_purpose_unique" UNIQUE("org_id","purpose");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- mcp_client_keys (reshape: HMAC + pepper + expiry + durable attribution)
-- ---------------------------------------------------------------------------
ALTER TABLE "mcp_client_keys" RENAME COLUMN "key_hash" TO "key_hmac";
--> statement-breakpoint
ALTER TABLE "mcp_client_keys" DROP COLUMN "roles";
--> statement-breakpoint
ALTER TABLE "mcp_client_keys" ADD COLUMN "pepper_version" integer NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_client_keys" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_client_keys" ADD COLUMN "created_by_label" text;
--> statement-breakpoint
ALTER TABLE "mcp_client_keys" ADD COLUMN "revoked_by_label" text;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- github_app_installations (new)
-- ---------------------------------------------------------------------------
CREATE TABLE "github_app_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text,
	"account_type" text,
	"repository_selection" text,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- repository_refs (new)
-- ---------------------------------------------------------------------------
CREATE TABLE "repository_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"ref_name" text NOT NULL,
	"revision_sha" text NOT NULL,
	"graph_version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_refs_org_repo_ref_unique" UNIQUE("org_id","repository_id","ref_name")
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- code_chunks (new)
-- ---------------------------------------------------------------------------
CREATE TABLE "code_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"ref_id" uuid NOT NULL,
	"revision_sha" text NOT NULL,
	"graph_node_id" text,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_chunks_org_ref_hash_unique" UNIQUE("org_id","ref_id","content_hash")
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- code_embeddings (new) -- vector(1024) requires the `vector` extension,
-- created earlier in 0005_enable_vector_extension.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE "code_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"ref_id" uuid NOT NULL,
	"revision_sha" text NOT NULL,
	"chunk_id" uuid NOT NULL,
	"graph_node_id" text,
	"embedding" vector(1024) NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimension" integer DEFAULT 1024 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_embeddings_chunk_provider_model_unique" UNIQUE("chunk_id","provider","model")
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Foreign keys for the four new tables
-- ---------------------------------------------------------------------------
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_refs" ADD CONSTRAINT "repository_refs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_refs" ADD CONSTRAINT "repository_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_ref_id_repository_refs_id_fk" FOREIGN KEY ("ref_id") REFERENCES "public"."repository_refs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_embeddings" ADD CONSTRAINT "code_embeddings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_embeddings" ADD CONSTRAINT "code_embeddings_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_embeddings" ADD CONSTRAINT "code_embeddings_ref_id_repository_refs_id_fk" FOREIGN KEY ("ref_id") REFERENCES "public"."repository_refs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_embeddings" ADD CONSTRAINT "code_embeddings_chunk_id_code_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."code_chunks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- btree indexes (org_id RLS support / RAG lookup) for the four new tables.
-- github_app_installations / code_embeddings need an explicit org_id index
-- (no leading-org_id unique covers it); repository_refs / code_chunks do NOT
-- (their org-leading unique constraints above already provide the btree).
-- ---------------------------------------------------------------------------
CREATE INDEX "github_app_installations_org_id_idx" ON "github_app_installations" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "code_chunks_graph_node_id_idx" ON "code_chunks" USING btree ("graph_node_id");
--> statement-breakpoint
CREATE INDEX "code_embeddings_org_id_idx" ON "code_embeddings" USING btree ("org_id");

-- W0-05 gap fill: make every repository/ref/chunk relationship tenant-consistent.
-- Existing inconsistent data deliberately makes this migration fail closed;
-- it is never silently reassigned to a different organization.

ALTER TABLE "repository_refs" ADD CONSTRAINT "repository_refs_org_repository_id_unique" UNIQUE("org_id", "repository_id", "id");
--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_org_repository_ref_id_unique" UNIQUE("org_id", "repository_id", "ref_id", "id");
--> statement-breakpoint

ALTER TABLE "permissions" DROP CONSTRAINT "permissions_repo_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "ticket_cache" DROP CONSTRAINT "ticket_cache_repo_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "style_rules" DROP CONSTRAINT "style_rules_repo_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "onboarding_steps" DROP CONSTRAINT "onboarding_steps_repo_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "repository_refs" DROP CONSTRAINT "repository_refs_repository_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "code_chunks" DROP CONSTRAINT "code_chunks_repository_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "code_chunks" DROP CONSTRAINT "code_chunks_ref_id_repository_refs_id_fk";
--> statement-breakpoint
ALTER TABLE "code_embeddings" DROP CONSTRAINT "code_embeddings_repository_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "code_embeddings" DROP CONSTRAINT "code_embeddings_ref_id_repository_refs_id_fk";
--> statement-breakpoint
ALTER TABLE "code_embeddings" DROP CONSTRAINT "code_embeddings_chunk_id_code_chunks_id_fk";
--> statement-breakpoint

ALTER TABLE "permissions" ADD CONSTRAINT "permissions_org_repository_fk" FOREIGN KEY ("org_id", "repo_id") REFERENCES "public"."repositories"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ticket_cache" ADD CONSTRAINT "ticket_cache_org_repository_fk" FOREIGN KEY ("org_id", "repo_id") REFERENCES "public"."repositories"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "style_rules" ADD CONSTRAINT "style_rules_org_repository_fk" FOREIGN KEY ("org_id", "repo_id") REFERENCES "public"."repositories"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "onboarding_steps" ADD CONSTRAINT "onboarding_steps_org_repository_fk" FOREIGN KEY ("org_id", "repo_id") REFERENCES "public"."repositories"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_refs" ADD CONSTRAINT "repository_refs_org_repository_fk" FOREIGN KEY ("org_id", "repository_id") REFERENCES "public"."repositories"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_org_repository_ref_fk" FOREIGN KEY ("org_id", "repository_id", "ref_id") REFERENCES "public"."repository_refs"("org_id", "repository_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "code_embeddings" ADD CONSTRAINT "code_embeddings_org_repository_ref_chunk_fk" FOREIGN KEY ("org_id", "repository_id", "ref_id", "chunk_id") REFERENCES "public"."code_chunks"("org_id", "repository_id", "ref_id", "id") ON DELETE cascade ON UPDATE no action;

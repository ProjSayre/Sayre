-- Custom SQL migration file, put your code below! --

-- Hand-authored raw SQL (drizzle-kit generate --custom).
--
-- RLS + CHECK constraints + the same-org-actor trigger + updated_at triggers
-- + hnsw cosine index + explicit grants for the W0-05 v2 six-table reshape
-- (0006_w0_05_v2_reshape_and_new_tables.sql). Mirrors the org_isolation
-- policy idiom from 0001_rls_and_role.sql, the trigger idiom from
-- 0002_triggers_and_indexes.sql, and the grant idiom from
-- 0004_rls_and_triggers_mcp_model_provider.sql exactly -- same
-- nullif(current_setting('app.org_id', true), '')::uuid idiom, same
-- trigger_set_updated_at() function (defined once in 0002, reused here).
--
-- The renamed `model_provider_configs` and the reshaped `mcp_client_keys`
-- KEEP their existing org_isolation policy, FORCE flag, updated_at trigger,
-- and grants across the 0006 rename/alter -- Postgres carries dependent
-- objects through ALTER TABLE ... RENAME and column changes, so none of that
-- is re-created here (see spec.md "0007_rls_triggers_indexes_w0_05_v2.sql").

-- ---------------------------------------------------------------------------
-- RLS: ENABLE + FORCE + org_isolation policy for the four new tables.
-- ---------------------------------------------------------------------------
ALTER TABLE github_app_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_app_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON github_app_installations
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE repository_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON repository_refs
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE code_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON code_chunks
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE code_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON code_embeddings
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------
ALTER TABLE model_provider_configs ADD CONSTRAINT model_provider_configs_purpose_check
  CHECK (purpose IN ('generation','embedding'));

--> statement-breakpoint

ALTER TABLE repository_refs ADD CONSTRAINT repository_refs_graph_version_nonneg
  CHECK (graph_version >= 0);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Same-org-actor trigger (Defect A fix -- see schema.ts's mcpClientKeys doc
-- comment and spec.md "Audit-integrity design"). Correct under both the
-- superuser seed/migrate path (sees real org_id, compares) and a sayre_app
-- tenant session (RLS hides cross-org users, so the lookup returns NULL ->
-- raise). No SECURITY DEFINER needed.
--
-- Fix for a same-user-for-both-columns false rejection on user deletion
-- (found in review): `created_by` and `revoked_by` are two independent
-- `uuid REFERENCES users(id) ON DELETE SET NULL` FKs. When a single key row
-- has BOTH columns pointing at the same user and that user is deleted,
-- Postgres does NOT null both columns in one atomic UPDATE -- each FK's
-- ON DELETE SET NULL action fires its own separate UPDATE naming only its
-- own column. So the first UPDATE (say, for created_by) fires this trigger
-- with NEW.created_by already NULL (correctly skipped below) but
-- NEW.revoked_by still carrying the *old* value of the now-already-deleted
-- user -- a fresh `SELECT ... FROM users WHERE id = NEW.revoked_by` finds no
-- row and would spuriously raise, blocking the whole DELETE FROM users.
--
-- Fix: on UPDATE, only re-validate a column that this particular statement
-- actually changed (OLD.<col> IS DISTINCT FROM NEW.<col>). A column left
-- untouched by this UPDATE doesn't need re-validation here -- if it's also
-- being nulled by the cascade, that happens in its own separate UPDATE
-- firing, where OLD/NEW *do* differ for it and NEW.<col> IS NULL correctly
-- short-circuits the check. INSERT is unaffected (OLD doesn't exist, so the
-- check always runs) and a genuine cross-org actor on a live INSERT/UPDATE
-- that actually sets/changes the column still raises, unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mcp_client_keys_same_org_actor()
RETURNS trigger AS $$
DECLARE actor_org uuid;
BEGIN
  IF NEW.created_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.created_by IS DISTINCT FROM NEW.created_by) THEN
    SELECT org_id INTO actor_org FROM users WHERE id = NEW.created_by;
    IF actor_org IS NULL OR actor_org <> NEW.org_id THEN
      RAISE EXCEPTION 'mcp_client_keys.created_by must reference a user in the same org'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.revoked_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.revoked_by IS DISTINCT FROM NEW.revoked_by) THEN
    SELECT org_id INTO actor_org FROM users WHERE id = NEW.revoked_by;
    IF actor_org IS NULL OR actor_org <> NEW.org_id THEN
      RAISE EXCEPTION 'mcp_client_keys.revoked_by must reference a user in the same org'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS same_org_actor ON mcp_client_keys;
CREATE TRIGGER same_org_actor BEFORE INSERT OR UPDATE ON mcp_client_keys
  FOR EACH ROW EXECUTE FUNCTION mcp_client_keys_same_org_actor();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuse trigger_set_updated_at() defined in 0002) for
-- the four new tables.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON github_app_installations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON github_app_installations
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON repository_refs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON repository_refs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON code_chunks;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON code_chunks
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON code_embeddings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON code_embeddings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- hnsw cosine index. hnsw chosen over ivfflat: no training data needed for an
-- initially-empty table and better recall; pgvector/pgvector:pg16 ships a
-- pgvector new enough for hnsw (see spec.md O-6).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS code_embeddings_embedding_cosine_idx
  ON code_embeddings USING hnsw (embedding vector_cosine_ops);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Explicit least-privilege grants (idempotent belt-and-suspenders; 0001's
-- ALTER DEFAULT PRIVILEGES should already cover tables the migrating
-- superuser creates, but assert it here so the acceptance test can't pass
-- vacuously -- same rationale as 0004).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON github_app_installations TO sayre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON repository_refs TO sayre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON code_chunks TO sayre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON code_embeddings TO sayre_app;

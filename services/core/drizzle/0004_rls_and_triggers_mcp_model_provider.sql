-- Custom SQL migration file, put your code below! --

-- Hand-authored raw SQL (drizzle-kit generate --custom).
--
-- RLS + updated_at triggers + explicit grants for the two W0-05 follow-up
-- tables (mcp_client_keys, model_provider), added by drizzle-kit generate
-- (0003_curvy_wolfpack.sql). Mirrors the org_isolation policy pattern from
-- 0001_rls_and_role.sql and the trigger pattern from 0002_triggers_and_indexes.sql
-- exactly -- same nullif(current_setting('app.org_id', true), '')::uuid idiom,
-- same trigger_set_updated_at() function (defined once in 0002, reused here).

-- mcp_client_keys: org-scoped agent API keys. SECURITY-SENSITIVE -- hash only.
ALTER TABLE mcp_client_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_client_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON mcp_client_keys
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

-- model_provider: per-org provider config. credential_ref is a REFERENCE, never a raw secret.
ALTER TABLE model_provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_provider FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON model_provider
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

-- updated_at triggers (reuse trigger_set_updated_at() defined in 0002).
DROP TRIGGER IF EXISTS set_updated_at ON mcp_client_keys;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON mcp_client_keys
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON model_provider;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON model_provider
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

-- Explicit least-privilege grants (idempotent belt-and-suspenders; 0001's
-- ALTER DEFAULT PRIVILEGES should already cover tables the migrating superuser
-- creates, but assert it here so the acceptance test can't pass vacuously).
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_client_keys TO sayre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON model_provider TO sayre_app;

-- Custom SQL migration file, put your code below! --

-- Hand-authored raw SQL (drizzle-kit generate --custom).
--
-- Least-privilege runtime role: NOLOGIN privilege bundle, not a table owner,
-- NOBYPASSRLS. The docker POSTGRES_USER (sayre_dev) is a superuser, so if the
-- app ever connected as it, RLS would be a silent no-op -- migrations/admin/
-- seed run as the superuser (bypass -- fine, they are trusted), but tenant
-- traffic MUST run as this non-superuser, NOBYPASSRLS, non-owner role.
--
-- Production runtime login role/secret provisioning is out of scope here (see
-- spec.md O-3) -- a later infra ticket grants a LOGIN role membership in this
-- NOLOGIN bundle. No passwords are committed in this file.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sayre_app') THEN
    CREATE ROLE sayre_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO sayre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sayre_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sayre_app;

--> statement-breakpoint

-- organizations: tenant root, keyed on id (not org_id -- organizations IS the org).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations
  USING      (id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON users
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON repositories
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

-- permissions: RLS here is ONLY org_id tenant isolation. The org/repo/branch/
-- path prefix-match authorization logic is deliberately NOT encoded in any
-- policy -- it belongs to the Graph Query Service (later ticket; see
-- .claude/rules/security-multitenancy.md and spec.md "Out").
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON permissions
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE ticket_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ticket_cache
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE style_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON style_rules
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

ALTER TABLE onboarding_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON onboarding_steps
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Custom SQL migration file, put your code below! --

-- Hand-authored raw SQL (drizzle-kit generate --custom).
--
-- Keeps `updated_at` fresh on every UPDATE, and adds the org/repo/branch/path
-- prefix index on `permissions` to support future `path_prefix LIKE 'x%'`
-- prefix scans by the Graph Query Service (O-2: plain text + text_pattern_ops,
-- not ltree -- RLS does not evaluate path scoping, so the heavier ltree/GiST
-- machinery is deferred until there's a real query workload to optimize).
--
-- Per-table org_id/id indexes supporting the RLS policies were already
-- emitted alongside the table DDL in 0000 (via Drizzle's index() calls in
-- src/db/schema.ts).

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON organizations;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON users;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON repositories;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON repositories
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON permissions;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON permissions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON ticket_cache;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ticket_cache
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON style_rules;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON style_rules
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON onboarding_steps;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON onboarding_steps
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

-- Prefix-match support for the Graph Query Service's future
-- `path_prefix LIKE 'x%'` scans, scoped by org/repo/branch.
CREATE INDEX permissions_org_repo_branch_path_prefix_idx
  ON permissions (org_id, repo_id, branch, path_prefix text_pattern_ops);

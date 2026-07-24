-- W4-02: immutable, tenant-scoped Agent/Skill MD version history.
--
-- The live graph node remains the authorization boundary. This table stores
-- only versioned content and audit attribution after that node has been
-- authorized by Graph Query Service.

CREATE TABLE agent_skill_md_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL,
  ref_name text NOT NULL,
  graph_node_id text NOT NULL,
  node_path text NOT NULL,
  node_label text NOT NULL,
  revision_sha text NOT NULL,
  version integer NOT NULL,
  content text NOT NULL,
  editor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  editor_label text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT agent_skill_md_versions_org_repository_fk
    FOREIGN KEY (org_id, repo_id)
    REFERENCES repositories(org_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_skill_md_versions_scope_version_unique
    UNIQUE (org_id, repo_id, ref_name, graph_node_id, version),
  CONSTRAINT agent_skill_md_versions_node_label_check
    CHECK (node_label IN ('Folder', 'File')),
  CONSTRAINT agent_skill_md_versions_version_positive_check
    CHECK (version > 0),
  CONSTRAINT agent_skill_md_versions_content_size_check
    CHECK (octet_length(content) BETWEEN 1 AND 131072)
);

--> statement-breakpoint

CREATE INDEX agent_skill_md_versions_latest_idx
  ON agent_skill_md_versions
  (org_id, repo_id, ref_name, graph_node_id, version DESC);

--> statement-breakpoint

ALTER TABLE agent_skill_md_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skill_md_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON agent_skill_md_versions
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION agent_skill_md_versions_same_org_editor()
RETURNS trigger AS $$
DECLARE editor_org uuid;
BEGIN
  IF NEW.editor_user_id IS NOT NULL THEN
    SELECT org_id INTO editor_org FROM users WHERE id = NEW.editor_user_id;
    IF editor_org IS NULL OR editor_org <> NEW.org_id THEN
      RAISE EXCEPTION 'agent_skill_md_versions.editor_user_id must reference a user in the same org'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_skill_md_versions_same_org_editor
  BEFORE INSERT ON agent_skill_md_versions
  FOR EACH ROW EXECUTE FUNCTION agent_skill_md_versions_same_org_editor();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION agent_skill_md_versions_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_skill_md_versions rows are immutable'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_skill_md_versions_no_update_delete
  BEFORE UPDATE OR DELETE ON agent_skill_md_versions
  FOR EACH ROW EXECUTE FUNCTION agent_skill_md_versions_immutable();

--> statement-breakpoint

GRANT SELECT, INSERT ON agent_skill_md_versions TO sayre_app;

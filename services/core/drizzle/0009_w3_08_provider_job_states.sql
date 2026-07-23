-- W3-08: minimal tenant-scoped model-provider job visibility.
--
-- Persist only closed enum state, sanitized reason codes, scope identifiers, and
-- timestamps. Provider/model/endpoint/prompt/response/raw error data has no column
-- here and therefore cannot accidentally become part of the visible-state contract.

ALTER TABLE repositories
  ADD CONSTRAINT repositories_org_id_id_unique UNIQUE (org_id, id);

--> statement-breakpoint

CREATE TABLE model_provider_job_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  ref_name text NOT NULL,
  revision_sha text NOT NULL,
  surface text NOT NULL,
  status text NOT NULL,
  reason_code text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT model_provider_job_states_org_repo_ref_surface_unique
    UNIQUE (org_id, repository_id, ref_name, surface),
  CONSTRAINT model_provider_job_states_org_fk
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT model_provider_job_states_org_repository_fk
    FOREIGN KEY (org_id, repository_id)
    REFERENCES repositories(org_id, id) ON DELETE CASCADE,
  CONSTRAINT model_provider_job_states_surface_check
    CHECK (surface IN ('product', 'onboarding', 'chatbot')),
  CONSTRAINT model_provider_job_states_status_check
    CHECK (status IN ('generating', 'ready', 'degraded', 'failed')),
  CONSTRAINT model_provider_job_states_reason_check
    CHECK (
      reason_code IS NULL OR reason_code IN (
        'timeout',
        'circuit_open',
        'provider_error',
        'retry_exhausted',
        'processing_error'
      )
    ),
  CONSTRAINT model_provider_job_states_status_reason_check
    CHECK (
      (status IN ('generating', 'ready') AND reason_code IS NULL)
      OR
      (status IN ('degraded', 'failed') AND reason_code IS NOT NULL)
    )
);

--> statement-breakpoint

CREATE INDEX model_provider_job_states_scope_updated_idx
  ON model_provider_job_states
  (org_id, repository_id, ref_name, surface, updated_at DESC);

--> statement-breakpoint

ALTER TABLE model_provider_job_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_provider_job_states FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON model_provider_job_states
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON model_provider_job_states;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON model_provider_job_states
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON model_provider_job_states TO sayre_app;

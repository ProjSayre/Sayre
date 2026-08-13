-- Custom SQL migration file, put your code below! --

-- W7-01: paginated GitHub installation discovery, replacing the 25-repo-per-callback
-- cap. Three parts, in this order:
--   1. github_installation_sync -- the durable, org-scoped run row. Doubles as the
--      transactional outbox for the discovery job (OQ-3): the request path (install
--      callback / manual reconcile) only ever commits a row; the dispatcher below is
--      the only thing that calls BullMQ enqueue().
--   2. Two additive `repositories` sweep-marker columns (OQ-4).
--   3. The dispatcher boundary -- a NOLOGIN/NOINHERIT/NOBYPASSRLS owner role plus three
--      bounded SECURITY DEFINER functions -- modelled column-for-column on migration
--      0012's `github_initial_parse_outbox` boundary (see that file's header). This is a
--      SEPARATE, parallel boundary: it never touches 0012's table, role, or functions.

-- ---------------------------------------------------------------------------
-- Part 1: github_installation_sync
-- ---------------------------------------------------------------------------
CREATE TABLE "github_installation_sync" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "installation_id" bigint NOT NULL,
  "run_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "status" text NOT NULL DEFAULT 'pending',
  "reason" text NOT NULL,
  "next_page" integer NOT NULL DEFAULT 1,
  "total_count" integer,
  "discovered_count" integer NOT NULL DEFAULT 0,
  "registered_count" integer NOT NULL DEFAULT 0,
  "enqueued_count" integer NOT NULL DEFAULT 0,
  "revoked_count" integer NOT NULL DEFAULT 0,
  "sweep_outcome" text NOT NULL DEFAULT 'not_applicable',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_error_code" text,
  "requested_by_subject_type" text,
  "requested_by_subject_id" text,
  -- OQ-3 dispatch bookkeeping (mirrors github_initial_parse_outbox's delivery columns).
  "dispatch_attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "completed_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT github_installation_sync_status_check
    CHECK (status IN ('pending','running','complete','failed','cancelled')),
  CONSTRAINT github_installation_sync_reason_check
    CHECK (reason IN ('app_install','manual_reconcile')),
  CONSTRAINT github_installation_sync_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code IN
           ('provider_unavailable','page_limit_exceeded','internal_error')),
  CONSTRAINT github_installation_sync_sweep_outcome_check
    CHECK (sweep_outcome IN ('not_applicable','applied','withheld_coverage',
                             'withheld_empty_result','withheld_ratio')),
  CONSTRAINT github_installation_sync_subject_check
    CHECK ((requested_by_subject_type IS NULL) = (requested_by_subject_id IS NULL)
           AND (requested_by_subject_type IS NULL
                OR requested_by_subject_type IN ('user','agent_key'))),
  CONSTRAINT github_installation_sync_next_page_check CHECK (next_page >= 1),
  CONSTRAINT github_installation_sync_lease_pair_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT github_installation_sync_counts_check
    CHECK (discovered_count >= 0 AND registered_count >= 0
           AND enqueued_count >= 0 AND revoked_count >= 0
           AND attempt_count >= 0 AND dispatch_attempt_count >= 0
           AND (total_count IS NULL OR total_count >= 0)),
  CONSTRAINT github_installation_sync_org_installation_unique
    UNIQUE (org_id, installation_id)
);

--> statement-breakpoint

ALTER TABLE "github_installation_sync" ADD CONSTRAINT "github_installation_sync_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint

CREATE INDEX "github_installation_sync_org_status_idx" ON "github_installation_sync" ("org_id", "status");

--> statement-breakpoint

-- The dispatcher's due scan.
CREATE INDEX "github_installation_sync_dispatch_due_idx"
  ON "github_installation_sync" ("next_attempt_at", "created_at")
  WHERE "status" IN ('pending','running','failed');

--> statement-breakpoint

ALTER TABLE github_installation_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installation_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON github_installation_sync
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON github_installation_sync;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON github_installation_sync
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

-- Least privilege for the tenant runtime role: it owns RUN state, not DISPATCH state.
-- No DELETE, ever -- a run row is retired by status transition, never removed.
GRANT SELECT, INSERT ON github_installation_sync TO sayre_app;
GRANT UPDATE (status, reason, run_id, next_page, total_count, discovered_count,
              registered_count, enqueued_count, revoked_count, sweep_outcome,
              attempt_count, last_error_code, requested_by_subject_type,
              requested_by_subject_id, next_attempt_at, started_at, completed_at,
              completed_run_id, updated_at)
  ON github_installation_sync TO sayre_app;
-- Deliberately NOT granted to sayre_app: lease_token, lease_expires_at, dispatched_at,
-- dispatch_attempt_count. Dispatch bookkeeping is the dispatcher's alone. next_attempt_at
-- IS granted because the run's heartbeat lives there (AC-23).

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Part 2: additive `repositories` sweep markers (OQ-4). Existing repositories RLS
-- policy covers them unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE repositories ADD COLUMN "last_discovery_run_id" uuid;
ALTER TABLE repositories ADD COLUMN "last_discovery_at" timestamp with time zone;

--> statement-breakpoint

CREATE INDEX repositories_org_last_discovery_idx
  ON repositories (org_id, last_discovery_run_id) WHERE revoked_at IS NULL;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Part 3: OQ-3 dispatcher boundary -- the same shape migration 0012 establishes,
-- verbatim in structure.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dispatcher_role record;
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolbypassrls
    INTO dispatcher_role
    FROM pg_roles
   WHERE rolname = 'sayre_installation_discovery_dispatcher';

  IF NOT FOUND THEN
    CREATE ROLE sayre_installation_discovery_dispatcher
      NOLOGIN
      NOINHERIT
      NOBYPASSRLS;
  ELSIF dispatcher_role.rolcanlogin
     OR dispatcher_role.rolsuper
     OR dispatcher_role.rolbypassrls THEN
    RAISE EXCEPTION
      'sayre_installation_discovery_dispatcher exists with unsafe role attributes';
  END IF;

  SELECT oid, rolcanlogin, rolsuper, rolbypassrls
    INTO dispatcher_role
    FROM pg_roles
   WHERE rolname = 'sayre_installation_discovery_dispatcher';

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members
     WHERE roleid = dispatcher_role.oid
        OR member = dispatcher_role.oid
  ) THEN
    RAISE EXCEPTION
      'sayre_installation_discovery_dispatcher must not have role memberships';
  END IF;
END
$$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO sayre_installation_discovery_dispatcher;
REVOKE ALL PRIVILEGES ON github_installation_sync
  FROM sayre_installation_discovery_dispatcher;
-- Column-scoped: the dispatcher can see and move dispatch/lease bookkeeping only. It can
-- never read counters, the requesting subject, or the cursor, and can never INSERT/DELETE.
GRANT SELECT (
  id,
  org_id,
  installation_id,
  run_id,
  reason,
  status,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  dispatched_at,
  dispatch_attempt_count,
  created_at
) ON github_installation_sync TO sayre_installation_discovery_dispatcher;
GRANT UPDATE (
  dispatch_attempt_count,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  dispatched_at,
  updated_at
) ON github_installation_sync TO sayre_installation_discovery_dispatcher;

CREATE POLICY dispatcher_select
  ON github_installation_sync
  FOR SELECT
  TO sayre_installation_discovery_dispatcher
  USING (true);
CREATE POLICY dispatcher_update
  ON github_installation_sync
  FOR UPDATE
  TO sayre_installation_discovery_dispatcher
  USING (true)
  WITH CHECK (true);

--> statement-breakpoint

GRANT CREATE ON SCHEMA public TO sayre_installation_discovery_dispatcher;

CREATE OR REPLACE FUNCTION public.claim_github_installation_discovery(
  requested_batch_size integer,
  requested_lease_seconds integer
)
RETURNS TABLE (
  id uuid,
  lease_token uuid,
  org_id uuid,
  installation_id bigint,
  run_id uuid,
  reason text,
  dispatch_attempt_count integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF requested_batch_size < 0 OR requested_batch_size > 25 THEN
    RAISE EXCEPTION 'requested_batch_size must be between 0 and 25'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF requested_lease_seconds < 10 OR requested_lease_seconds > 300 THEN
    RAISE EXCEPTION 'requested_lease_seconds must be between 10 and 300'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH due AS MATERIALIZED (
    SELECT candidate.id
      FROM public.github_installation_sync AS candidate
     WHERE (
             candidate.status IN ('pending','running')
             OR (candidate.status = 'failed' AND candidate.last_error_code IS DISTINCT FROM 'page_limit_exceeded')
           )
       AND candidate.next_attempt_at <= clock_timestamp()
       AND (
         candidate.lease_expires_at IS NULL
         OR candidate.lease_expires_at <= clock_timestamp()
       )
       AND candidate.dispatch_attempt_count < 10
     ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
     FOR UPDATE SKIP LOCKED
     LIMIT requested_batch_size
  ),
  claimed AS (
    UPDATE public.github_installation_sync AS candidate
       SET dispatch_attempt_count = candidate.dispatch_attempt_count + 1,
           lease_token = gen_random_uuid(),
           lease_expires_at =
             clock_timestamp() + make_interval(secs => requested_lease_seconds),
           updated_at = clock_timestamp()
      FROM due
     WHERE candidate.id = due.id
     RETURNING
       candidate.id,
       candidate.lease_token,
       candidate.org_id,
       candidate.installation_id,
       candidate.run_id,
       candidate.reason,
       candidate.dispatch_attempt_count
  )
  SELECT claimed.id,
         claimed.lease_token,
         claimed.org_id,
         claimed.installation_id,
         claimed.run_id,
         claimed.reason,
         claimed.dispatch_attempt_count
    FROM claimed;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_github_installation_discovery(
  requested_id uuid,
  requested_lease_token uuid,
  requested_redispatch_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  updated_count integer;
BEGIN
  IF requested_redispatch_seconds < 30 OR requested_redispatch_seconds > 3600 THEN
    RAISE EXCEPTION 'requested_redispatch_seconds must be between 30 and 3600'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A watchdog re-arm, NOT terminal: dispatched_at is a bookkeeping marker only, and
  -- next_attempt_at is pushed forward so a run that neither progresses (heartbeat) nor
  -- terminates becomes due again -- this is what survives a total Redis loss (AC-20).
  UPDATE public.github_installation_sync
     SET dispatched_at = clock_timestamp(),
         lease_token = NULL,
         lease_expires_at = NULL,
         next_attempt_at = clock_timestamp() + make_interval(secs => requested_redispatch_seconds),
         updated_at = clock_timestamp()
   WHERE id = requested_id
     AND lease_token = requested_lease_token;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.retry_github_installation_discovery(
  requested_id uuid,
  requested_lease_token uuid,
  requested_delay_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  updated_count integer;
BEGIN
  IF requested_delay_seconds < 1 OR requested_delay_seconds > 300 THEN
    RAISE EXCEPTION 'requested_delay_seconds must be between 1 and 300'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.github_installation_sync
     SET next_attempt_at =
           clock_timestamp() + make_interval(secs => requested_delay_seconds),
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE id = requested_id
     AND lease_token = requested_lease_token;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END
$function$;

ALTER FUNCTION public.claim_github_installation_discovery(integer, integer)
  OWNER TO sayre_installation_discovery_dispatcher;
ALTER FUNCTION public.complete_github_installation_discovery(uuid, uuid, integer)
  OWNER TO sayre_installation_discovery_dispatcher;
ALTER FUNCTION public.retry_github_installation_discovery(uuid, uuid, integer)
  OWNER TO sayre_installation_discovery_dispatcher;
REVOKE CREATE ON SCHEMA public FROM sayre_installation_discovery_dispatcher;

REVOKE ALL ON FUNCTION
  public.claim_github_installation_discovery(integer, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.complete_github_installation_discovery(uuid, uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.retry_github_installation_discovery(uuid, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.claim_github_installation_discovery(integer, integer)
  TO sayre_app;
GRANT EXECUTE ON FUNCTION
  public.complete_github_installation_discovery(uuid, uuid, integer)
  TO sayre_app;
GRANT EXECUTE ON FUNCTION
  public.retry_github_installation_discovery(uuid, uuid, integer)
  TO sayre_app;

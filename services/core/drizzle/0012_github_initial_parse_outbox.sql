-- Durable W1-06 callback -> ingestion handoff.
--
-- The callback writes the complete repo.initial_parse envelope in the same
-- tenant-scoped transaction as the installation/repository rows. A dedicated
-- NOLOGIN/NOBYPASSRLS function owner can only lease due outbox rows and update
-- their delivery bookkeeping. It has no access to any other product table,
-- cannot insert/delete outbox rows, and cannot be assumed by the runtime role.
--
-- This is deliberately specific to GitHub initial parses. It does not create
-- a second queue system or pre-empt a future general integration outbox.

CREATE TABLE github_initial_parse_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type text DEFAULT 'repo.initial_parse' NOT NULL,
  idempotency_key text NOT NULL,
  envelope jsonb NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  delivered_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT github_initial_parse_outbox_org_idempotency_unique
    UNIQUE (org_id, idempotency_key),
  CONSTRAINT github_initial_parse_outbox_event_type_check
    CHECK (event_type = 'repo.initial_parse'),
  CONSTRAINT github_initial_parse_outbox_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT github_initial_parse_outbox_lease_pair_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT github_initial_parse_outbox_envelope_check
    CHECK (
      jsonb_typeof(envelope) = 'object'
      AND envelope->>'type' = event_type
      AND envelope->>'org_id' = org_id::text
      AND envelope->>'idempotency_key' = idempotency_key
      AND length(btrim(envelope->>'message_id')) > 0
      AND envelope->>'schema_version' = '1'
      AND length(btrim(envelope->>'occurred_at')) > 0
      AND envelope->>'source' = 'github-app-install'
      AND jsonb_typeof(envelope->'payload') = 'object'
      AND envelope->'payload'->>'provider' = 'github'
      AND envelope->'payload'->>'type' = 'initial_parse'
      AND envelope->'payload'->>'reason' = 'app_install'
      AND length(btrim(envelope->'payload'->>'installation_id')) > 0
      AND length(btrim(envelope->'payload'->>'ref')) > 0
      AND length(btrim(envelope->'payload'->>'revision_sha')) > 0
      AND jsonb_typeof(envelope->'payload'->'repo') = 'object'
      AND length(btrim(envelope->'payload'->'repo'->>'repo_id')) > 0
      AND length(btrim(envelope->'payload'->'repo'->>'provider_repo_id')) > 0
      AND length(btrim(envelope->'payload'->'repo'->>'full_name')) > 0
    )
);

--> statement-breakpoint

CREATE INDEX github_initial_parse_outbox_due_idx
  ON github_initial_parse_outbox (next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

--> statement-breakpoint

ALTER TABLE github_initial_parse_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_initial_parse_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON github_initial_parse_outbox
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON github_initial_parse_outbox;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON github_initial_parse_outbox
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

--> statement-breakpoint

-- Default privileges from 0001 are intentionally narrowed: tenant request
-- code may append immutable events, but only the dispatcher functions may
-- mutate delivery state or inspect envelopes outside an org transaction.
REVOKE ALL PRIVILEGES ON github_initial_parse_outbox FROM sayre_app;
GRANT INSERT (org_id, event_type, idempotency_key, envelope)
  ON github_initial_parse_outbox TO sayre_app;
-- PostgreSQL requires SELECT on an ON CONFLICT arbiter's columns even for
-- DO NOTHING. These two identifiers are visible only inside the caller's
-- existing tenant RLS context; the envelope and delivery columns stay hidden.
GRANT SELECT (org_id, idempotency_key)
  ON github_initial_parse_outbox TO sayre_app;

--> statement-breakpoint

DO $$
DECLARE
  dispatcher_role record;
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolbypassrls
    INTO dispatcher_role
    FROM pg_roles
   WHERE rolname = 'sayre_initial_parse_outbox_dispatcher';

  IF NOT FOUND THEN
    CREATE ROLE sayre_initial_parse_outbox_dispatcher
      NOLOGIN
      NOINHERIT
      NOBYPASSRLS;
  ELSIF dispatcher_role.rolcanlogin
     OR dispatcher_role.rolsuper
     OR dispatcher_role.rolbypassrls THEN
    RAISE EXCEPTION
      'sayre_initial_parse_outbox_dispatcher exists with unsafe role attributes';
  END IF;

  SELECT oid, rolcanlogin, rolsuper, rolbypassrls
    INTO dispatcher_role
    FROM pg_roles
   WHERE rolname = 'sayre_initial_parse_outbox_dispatcher';

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members
     WHERE roleid = dispatcher_role.oid
        OR member = dispatcher_role.oid
  ) THEN
    RAISE EXCEPTION
      'sayre_initial_parse_outbox_dispatcher must not have role memberships';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO sayre_initial_parse_outbox_dispatcher;
REVOKE ALL PRIVILEGES ON github_initial_parse_outbox
  FROM sayre_initial_parse_outbox_dispatcher;
GRANT SELECT (
  id,
  envelope,
  attempt_count,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  delivered_at,
  created_at
) ON github_initial_parse_outbox TO sayre_initial_parse_outbox_dispatcher;
GRANT UPDATE (
  attempt_count,
  next_attempt_at,
  lease_token,
  lease_expires_at,
  delivered_at,
  updated_at
) ON github_initial_parse_outbox TO sayre_initial_parse_outbox_dispatcher;

CREATE POLICY initial_parse_outbox_dispatcher_select
  ON github_initial_parse_outbox
  FOR SELECT
  TO sayre_initial_parse_outbox_dispatcher
  USING (true);
CREATE POLICY initial_parse_outbox_dispatcher_update
  ON github_initial_parse_outbox
  FOR UPDATE
  TO sayre_initial_parse_outbox_dispatcher
  USING (true)
  WITH CHECK (true);

--> statement-breakpoint

GRANT CREATE ON SCHEMA public TO sayre_initial_parse_outbox_dispatcher;

CREATE OR REPLACE FUNCTION public.claim_github_initial_parse_outbox(
  requested_batch_size integer,
  requested_lease_seconds integer
)
RETURNS TABLE (
  id uuid,
  lease_token uuid,
  envelope jsonb,
  attempt_count integer
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
      FROM public.github_initial_parse_outbox AS candidate
     WHERE candidate.delivered_at IS NULL
       AND candidate.next_attempt_at <= clock_timestamp()
       AND (
         candidate.lease_expires_at IS NULL
         OR candidate.lease_expires_at <= clock_timestamp()
       )
     ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
     FOR UPDATE SKIP LOCKED
     LIMIT requested_batch_size
  ),
  claimed AS (
    UPDATE public.github_initial_parse_outbox AS candidate
       SET attempt_count = candidate.attempt_count + 1,
           lease_token = gen_random_uuid(),
           lease_expires_at =
             clock_timestamp() + make_interval(secs => requested_lease_seconds),
           updated_at = clock_timestamp()
      FROM due
     WHERE candidate.id = due.id
     RETURNING
       candidate.id,
       candidate.lease_token,
       candidate.envelope,
       candidate.attempt_count
  )
  SELECT claimed.id,
         claimed.lease_token,
         claimed.envelope,
         claimed.attempt_count
    FROM claimed;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_github_initial_parse_outbox(
  requested_id uuid,
  requested_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH completed AS (
    UPDATE public.github_initial_parse_outbox
       SET delivered_at = clock_timestamp(),
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE id = requested_id
       AND delivered_at IS NULL
       AND lease_token = requested_lease_token
     RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM completed)
$function$;

CREATE OR REPLACE FUNCTION public.retry_github_initial_parse_outbox(
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

  UPDATE public.github_initial_parse_outbox
     SET next_attempt_at =
           clock_timestamp() + make_interval(secs => requested_delay_seconds),
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE id = requested_id
     AND delivered_at IS NULL
     AND lease_token = requested_lease_token;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END
$function$;

ALTER FUNCTION public.claim_github_initial_parse_outbox(integer, integer)
  OWNER TO sayre_initial_parse_outbox_dispatcher;
ALTER FUNCTION public.complete_github_initial_parse_outbox(uuid, uuid)
  OWNER TO sayre_initial_parse_outbox_dispatcher;
ALTER FUNCTION public.retry_github_initial_parse_outbox(uuid, uuid, integer)
  OWNER TO sayre_initial_parse_outbox_dispatcher;
REVOKE CREATE ON SCHEMA public FROM sayre_initial_parse_outbox_dispatcher;

REVOKE ALL ON FUNCTION
  public.claim_github_initial_parse_outbox(integer, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.complete_github_initial_parse_outbox(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.retry_github_initial_parse_outbox(uuid, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.claim_github_initial_parse_outbox(integer, integer)
  TO sayre_app;
GRANT EXECUTE ON FUNCTION
  public.complete_github_initial_parse_outbox(uuid, uuid)
  TO sayre_app;
GRANT EXECUTE ON FUNCTION
  public.retry_github_initial_parse_outbox(uuid, uuid, integer)
  TO sayre_app;

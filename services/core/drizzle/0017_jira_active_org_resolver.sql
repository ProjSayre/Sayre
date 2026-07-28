-- Narrow pre-tenant lookup boundary for Jira ticket polling.
--
-- `jira_connections` is protected by FORCE RLS, so the ordinary `sayre_app`
-- role correctly sees zero rows until `app.org_id` is known. The Jira poll
-- loop has to discover WHICH orgs have an active connection before it can
-- set that org's context, which creates the same deliberate bootstrap read
-- migration 0011 solved for GitHub installation routing -- mirrored here
-- exactly, same shape, same safeguards:
--
--   * a NOLOGIN, NOBYPASSRLS role can SELECT only the two required columns;
--   * one SELECT-only policy exposes rows to that role;
--   * one SECURITY DEFINER function takes no tenant-controlled input at all
--     (unlike 0011's single-id lookup, this one lists every active org, since
--     that IS the query the poll loop needs) and returns only org_id;
--   * PUBLIC has no EXECUTE and sayre_app can call only this function.
--
-- The function owner has no login and no membership is granted to it, so the
-- ordinary runtime role cannot SET ROLE into the cross-tenant reader.

DO $$
DECLARE
  resolver_role record;
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolbypassrls
    INTO resolver_role
    FROM pg_roles
   WHERE rolname = 'sayre_jira_poll_resolver';

  IF NOT FOUND THEN
    CREATE ROLE sayre_jira_poll_resolver
      NOLOGIN
      NOINHERIT
      NOBYPASSRLS;
  ELSIF resolver_role.rolcanlogin
     OR resolver_role.rolsuper
     OR resolver_role.rolbypassrls THEN
    RAISE EXCEPTION
      'sayre_jira_poll_resolver exists with unsafe role attributes';
  END IF;

  SELECT oid, rolcanlogin, rolsuper, rolbypassrls
    INTO resolver_role
    FROM pg_roles
   WHERE rolname = 'sayre_jira_poll_resolver';

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members
     WHERE roleid = resolver_role.oid
        OR member = resolver_role.oid
  ) THEN
    RAISE EXCEPTION
      'sayre_jira_poll_resolver must not have role memberships';
  END IF;
END
$$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO sayre_jira_poll_resolver;
REVOKE ALL PRIVILEGES ON jira_connections FROM sayre_jira_poll_resolver;
REVOKE SELECT (
  id,
  org_id,
  cloud_id,
  site_url,
  site_name,
  jira_access_token_enc,
  jira_refresh_token_enc,
  access_token_expires_at,
  scopes,
  connected_by_user_id,
  connected_by_label,
  connected_by_account_id,
  last_synced_at,
  connected_at,
  revoked_at,
  revoked_by,
  revoked_by_label,
  created_at,
  updated_at
) ON jira_connections FROM sayre_jira_poll_resolver;
GRANT SELECT (org_id, revoked_at)
  ON jira_connections
  TO sayre_jira_poll_resolver;

--> statement-breakpoint

DROP POLICY IF EXISTS jira_poll_resolver_lookup ON jira_connections;
CREATE POLICY jira_poll_resolver_lookup
  ON jira_connections
  FOR SELECT
  TO sayre_jira_poll_resolver
  USING (true);

--> statement-breakpoint

-- ALTER FUNCTION ... OWNER requires transient CREATE on the containing schema.
-- Revoke it immediately after ownership transfer; the role retains only USAGE.
GRANT CREATE ON SCHEMA public TO sayre_jira_poll_resolver;

CREATE OR REPLACE FUNCTION public.list_active_jira_connection_org_ids()
RETURNS TABLE (org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT DISTINCT connection.org_id
    FROM public.jira_connections AS connection
   WHERE connection.revoked_at IS NULL
$function$;

ALTER FUNCTION public.list_active_jira_connection_org_ids()
  OWNER TO sayre_jira_poll_resolver;
REVOKE CREATE ON SCHEMA public FROM sayre_jira_poll_resolver;
REVOKE ALL ON FUNCTION public.list_active_jira_connection_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_active_jira_connection_org_ids()
  TO sayre_app;

-- Narrow pre-tenant lookup boundary for GitHub App installation routing.
--
-- `github_app_installations` is protected by FORCE RLS, so the ordinary
-- `sayre_app` role correctly sees zero rows until `app.org_id` is known. GitHub
-- webhook routing has to discover that org from GitHub's signed installation
-- id, however, which creates a deliberate bootstrap read.
--
-- Keep that exception smaller than an admin/service connection:
--   * a NOLOGIN, NOBYPASSRLS role can SELECT only the four required columns;
--   * one SELECT-only policy exposes rows to that role;
--   * one SECURITY DEFINER function accepts only a bigint installation id and
--     returns only org_id + active;
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
   WHERE rolname = 'sayre_installation_resolver';

  IF NOT FOUND THEN
    CREATE ROLE sayre_installation_resolver
      NOLOGIN
      NOINHERIT
      NOBYPASSRLS;
  ELSIF resolver_role.rolcanlogin
     OR resolver_role.rolsuper
     OR resolver_role.rolbypassrls THEN
    RAISE EXCEPTION
      'sayre_installation_resolver exists with unsafe role attributes';
  END IF;

  SELECT oid, rolcanlogin, rolsuper, rolbypassrls
    INTO resolver_role
    FROM pg_roles
   WHERE rolname = 'sayre_installation_resolver';

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members
     WHERE roleid = resolver_role.oid
        OR member = resolver_role.oid
  ) THEN
    RAISE EXCEPTION
      'sayre_installation_resolver must not have role memberships';
  END IF;
END
$$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO sayre_installation_resolver;
REVOKE ALL PRIVILEGES ON github_app_installations FROM sayre_installation_resolver;
REVOKE SELECT (
  id,
  org_id,
  installation_id,
  account_login,
  account_type,
  repository_selection,
  suspended_at,
  revoked_at,
  created_at,
  updated_at
) ON github_app_installations FROM sayre_installation_resolver;
GRANT SELECT (installation_id, org_id, suspended_at, revoked_at)
  ON github_app_installations
  TO sayre_installation_resolver;

--> statement-breakpoint

DROP POLICY IF EXISTS github_installation_resolver_lookup
  ON github_app_installations;
CREATE POLICY github_installation_resolver_lookup
  ON github_app_installations
  FOR SELECT
  TO sayre_installation_resolver
  USING (true);

--> statement-breakpoint

-- ALTER FUNCTION ... OWNER requires transient CREATE on the containing schema.
-- Revoke it immediately after ownership transfer; the role retains only USAGE.
GRANT CREATE ON SCHEMA public TO sayre_installation_resolver;

CREATE OR REPLACE FUNCTION public.resolve_github_installation_org(
  requested_installation_id bigint
)
RETURNS TABLE (org_id uuid, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT installation.org_id,
         installation.suspended_at IS NULL
           AND installation.revoked_at IS NULL AS active
    FROM public.github_app_installations AS installation
   WHERE installation.installation_id = requested_installation_id
$function$;

ALTER FUNCTION public.resolve_github_installation_org(bigint)
  OWNER TO sayre_installation_resolver;
REVOKE CREATE ON SCHEMA public FROM sayre_installation_resolver;
REVOKE ALL ON FUNCTION public.resolve_github_installation_org(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_github_installation_org(bigint)
  TO sayre_app;

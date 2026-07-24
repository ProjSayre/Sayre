-- W4-06: organization-scoped MCP rate policy and a deliberately narrow
-- pre-tenant key lookup. The function is the only read needed before org_id is
-- known; normal key administration still runs behind org RLS.

ALTER TABLE organizations
  ADD COLUMN mcp_rate_limit_per_minute integer DEFAULT 60 NOT NULL;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_mcp_rate_limit_check
  CHECK (mcp_rate_limit_per_minute BETWEEN 1 AND 10000);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION resolve_mcp_client_key(p_key_prefix text)
RETURNS TABLE (
  key_id uuid,
  org_id uuid,
  key_prefix text,
  key_hmac text,
  pepper_version integer,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_by uuid,
  rate_limit_per_minute integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT key.id,
         key.org_id,
         key.key_prefix,
         key.key_hmac,
         key.pepper_version,
         key.expires_at,
         key.revoked_at,
         key.created_by,
         org.mcp_rate_limit_per_minute
  FROM mcp_client_keys AS key
  JOIN organizations AS org ON org.id = key.org_id
  WHERE key.key_prefix = p_key_prefix
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION resolve_mcp_client_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_mcp_client_key(text) TO sayre_app;

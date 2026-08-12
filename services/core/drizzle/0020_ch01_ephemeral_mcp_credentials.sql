-- CH-01: ephemeral, conversation-bound, digest-only MCP credentials for the
-- first-party "Ask Sayre" chat loop. These live in the existing
-- `mcp_client_keys` table, discriminated by `kind`, so the existing
-- SECURITY DEFINER resolver, the agent_key RBAC-ceiling machinery in
-- graph-query/permissions.ts, and every MCP tool handler keep working with
-- zero code changes -- see spec.md's "Why the credential lives in
-- mcp_client_keys rather than a new table."
--
-- `DROP FUNCTION` before `CREATE` is mandatory here: Postgres rejects
-- `CREATE OR REPLACE FUNCTION` when the `RETURNS TABLE` column list changes,
-- and this recreate adds two columns to the result set. Dropping the
-- function also drops its grants, so REVOKE/GRANT are re-issued below.

ALTER TABLE mcp_client_keys ADD COLUMN kind text DEFAULT 'agent' NOT NULL;
--> statement-breakpoint
ALTER TABLE mcp_client_keys ADD COLUMN conversation_id uuid;
--> statement-breakpoint

-- Discriminator: only the two known credential families are legal.
ALTER TABLE mcp_client_keys ADD CONSTRAINT mcp_client_keys_kind_check
  CHECK (kind IN ('agent','chat_ephemeral'));
--> statement-breakpoint

-- Shape: an ephemeral row must carry the conversation binding and a mandatory
-- expiry; an ordinary agent row must never carry a conversation binding.
-- Deliberately does not force created_by to be non-null here: created_by is
-- ON DELETE SET NULL, and forcing that would make deleting a user fail
-- whenever that user has an ephemeral row outstanding -- the same cascade
-- defect already documented on mcp_client_keys_same_org_actor() in
-- drizzle/0007_*. Attribution is enforced by the issuing service (which
-- always sets created_by at insert time), and a null created_by already
-- fails closed in both resolveMcpCredential and
-- PostgresPermissionStore.getReadScope.
ALTER TABLE mcp_client_keys ADD CONSTRAINT mcp_client_keys_ephemeral_shape_check
  CHECK (
    (kind = 'chat_ephemeral' AND conversation_id IS NOT NULL AND expires_at IS NOT NULL)
    OR (kind = 'agent' AND conversation_id IS NULL)
  );
--> statement-breakpoint

-- TTL ceiling: an ephemeral row's expiry is bounded to at most 600 seconds
-- past its own creation, and must actually be in the future of it. Ordinary
-- agent rows are unconstrained here (their expiry policy predates this
-- migration and is unrelated).
ALTER TABLE mcp_client_keys ADD CONSTRAINT mcp_client_keys_ephemeral_ttl_check
  CHECK (
    kind <> 'chat_ephemeral'
    OR (expires_at > created_at AND expires_at <= created_at + interval '600 seconds')
  );
--> statement-breakpoint

-- Partial indexes, scoped to kind='chat_ephemeral' only -- Drizzle's schema
-- builder has no first-class partial-index support (same convention as
-- users_external_auth_id_unique in drizzle/0013_* and
-- jira_connections_active_org_unique in drizzle/0016_*).
CREATE INDEX mcp_client_keys_ephemeral_conversation_idx
  ON mcp_client_keys (org_id, conversation_id)
  WHERE kind = 'chat_ephemeral';
--> statement-breakpoint

CREATE INDEX mcp_client_keys_ephemeral_expires_idx
  ON mcp_client_keys (expires_at)
  WHERE kind = 'chat_ephemeral';
--> statement-breakpoint

-- Recreate the pre-tenant bootstrap lookup with the two new discriminator
-- columns in its result set. Still SECURITY DEFINER, still pinned to a safe
-- search_path, still STABLE -- only the column list changes.
DROP FUNCTION IF EXISTS resolve_mcp_client_key(text);
--> statement-breakpoint

CREATE FUNCTION resolve_mcp_client_key(p_key_prefix text)
RETURNS TABLE (
  key_id uuid,
  org_id uuid,
  key_prefix text,
  key_hmac text,
  pepper_version integer,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_by uuid,
  rate_limit_per_minute integer,
  kind text,
  conversation_id uuid
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
         org.mcp_rate_limit_per_minute,
         key.kind,
         key.conversation_id
  FROM mcp_client_keys AS key
  JOIN organizations AS org ON org.id = key.org_id
  WHERE key.key_prefix = p_key_prefix
  LIMIT 1
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION resolve_mcp_client_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_mcp_client_key(text) TO sayre_app;

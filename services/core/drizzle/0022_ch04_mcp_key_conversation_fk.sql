-- CH-04: closes CH-01's owed FK on mcp_client_keys.conversation_id. Both tables now
-- exist (chat_conversations landed in drizzle/0020_*), and 0020 already added
-- chat_conversations_org_id_id_unique, which is what makes this tenant-consistent
-- composite FK possible — the same idiom as chat_turns_org_conversation_fk.
--
-- No explicit MATCH clause is written below: MATCH SIMPLE (the default, not the
-- stricter alternative Postgres also offers) means an ordinary kind='agent' row
-- where conversation_id is null is exempt from the constraint with no extra
-- predicate, so a bare composite FK is sufficient here.
ALTER TABLE mcp_client_keys ADD CONSTRAINT mcp_client_keys_org_conversation_fk
  FOREIGN KEY ("org_id","conversation_id")
  REFERENCES "public"."chat_conversations"("org_id","id") ON DELETE cascade;
--> statement-breakpoint

-- ON DELETE CASCADE above creates a NEW route by which an mcp_client_keys row can be
-- deleted (delete a user -> chat_conversations cascades -> this cascades). CH-01's
-- ephemeral credentials carry their RBAC ceiling as `permissions` rows keyed
-- (subject_type='agent_key', subject_id=<key_prefix>) with no FK back to this table, so
-- that new route would orphan them — PostgresEphemeralMcpCredentialStore.deleteExpired
-- is the only caller that cleans them up today, and a cascade does not run it. Scoped to
-- kind='chat_ephemeral' to keep the blast radius to exactly the path this migration
-- introduces; W4-06 agent-key behavior is unchanged.
CREATE OR REPLACE FUNCTION mcp_client_keys_delete_ephemeral_ceiling()
RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'chat_ephemeral' THEN
    DELETE FROM permissions
     WHERE org_id = OLD.org_id
       AND subject_type = 'agent_key'
       AND subject_id = OLD.key_prefix;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS delete_ephemeral_ceiling ON mcp_client_keys;
CREATE TRIGGER delete_ephemeral_ceiling AFTER DELETE ON mcp_client_keys
  FOR EACH ROW EXECUTE FUNCTION mcp_client_keys_delete_ephemeral_ceiling();

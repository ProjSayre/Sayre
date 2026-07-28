-- Custom SQL migration file, put your code below! --

-- Hands-on gap-fix (see docs/post-mvp-backlog.md): a Jira/Linear ticket only
-- ever links to a File/Feature node via an explicit `[sayre:file:...]` /
-- `[sayre:feature:...]` tag in its own description -- there's no AI-driven
-- decision at all. This adds the storage the new Python
-- `TicketReferenceMatcher` writes to (embedding-similarity match against
-- `code_embeddings`, only computed when a ticket has no explicit tag) and
-- Node's `syncTicket()` reads from on the next sync cycle to merge in a
-- `node_id`-kind `TicketReference` before calling `graph.apply()`.

ALTER TABLE ticket_cache
  ADD COLUMN inferred_reference_node_id text,
  ADD COLUMN inferred_reference_score real,
  ADD COLUMN inferred_reference_computed_at timestamp with time zone;

-- W1-05 persists bounded excerpts per graph node. Identical snippets in two files
-- are distinct chunks and must not overwrite one another merely because their content
-- hashes match.
ALTER TABLE "code_chunks"
  DROP CONSTRAINT IF EXISTS "code_chunks_org_ref_hash_unique";
--> statement-breakpoint
ALTER TABLE "code_chunks"
  ADD CONSTRAINT "code_chunks_org_ref_node_index_hash_unique"
  UNIQUE("org_id", "ref_id", "graph_node_id", "chunk_index", "content_hash");

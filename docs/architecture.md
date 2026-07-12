# Logical Architecture

```
Browser (Next.js, React Flow / Sigma.js + graphology)
        |
   API Gateway  --  AuthN (JWT/session) + RBAC middleware
        |
   Core App Service (Node.js)  --  Service Layer + Graph Query Service
        |                                   |
   Realtime Service                   kicks off async jobs
   (WebSocket + Redis pub/sub)               |
        |                          -----------------------
        |                          |                      |
   Live canvas patches       SQS (Python fleet)     BullMQ (Node integration workers)
                                    |                      |
                          Ingestion/Delta Worker     GitHub / Jira / Linear sync
                          Semantic Enrichment Worker
                          Retrieval Service (RAG)
                                    |
                    -----------------------------------
                    |               |                  |
              PostgreSQL      Neo4j → Neptune     pgvector → OpenSearch
           (org/users/perms)   (codebase ontology)  (semantic chunks)
```

## Three tree views, one schema
Technical / Product / Onboarding are query shapes over one graph, not three datasets:
- **Technical Tree** — Folder/File nodes + structural edges (IMPORTS/CALLS/INHERITS)
- **Product Tree** — Feature nodes + PART_OF/REFERENCES edges, dashed-boundary grouping over the same Folder/File nodes
- **Onboarding Tree** — EnvStep nodes ordered by sequence

The Macro View (Project → Repo, cross-repo edges) sits above all three as a post-MVP addition (Sprint 6+).

## Key flows
- **Cold start**: GitHub App authorized → full Tree-sitter parse → bulk graph write + embeddings → Semantic Enrichment runs feature clustering/style/onboarding steps. Technical Tree is available first; Product/Onboarding may show "generating."
- **Steady-state push (15s target)**: webhook → Ingestion Worker parses only changed files → diffs AST against existing graph → upserts in one transaction → publishes `graph.updated` over SQS → Realtime Service fans out over WebSocket, patching only affected nodes. Semantic re-enrichment happens in parallel, out-of-band from the 15s budget.
- **AI query (Graph-Guided RAG)**: question on a node → Retrieval Service resolves the anchor node → bounded-hop traversal → fetches only in-scope Vector Store chunks → bounded prompt → Claude API call. Logs actual context tokens vs. a hypothetical full-repo count (the 70x reduction KPI).

For migration trigger thresholds, see `migration-triggers.md`.

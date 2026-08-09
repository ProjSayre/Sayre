# Full Ticket Backlog
## Codebase Ontology, Visualization, Agent Context & Model Provider Platform — derived from PRD v8 (Unified Edition) · July 2026

All 68 tickets, one flat list, in build order (wave, then ID). \* = same-wave dependency exception (hand off sequentially within that wave). See prior documents for full descriptions/acceptance criteria per ticket.

| ID | Title | Wave | Depends on | Executor |
|---|---|---|---|---|
| W0-00 | Dependency & environment baseline | 0 | none | AI agent |
| W0-01 | Monorepo and local-dev skeleton | 0 | W0-00 | AI agent |
| W0-02 | Graph DB schema & openCypher migrations | 0 | W0-00 | AI agent (schema review by human) |
| W0-03 | Service-layer convention & REST scaffold | 0 | W0-00 | AI agent |
| W0-04 | SQS + BullMQ wiring | 0 | W0-00 | AI agent |
| W0-05 | PostgreSQL schema & migrations | 0 | W0-00 | AI agent |
| W0-06 | Vector-store concurrency instrumentation | 0 | W0-00 | AI agent |
| W0-07 | Secrets convention & loader | 0 | W0-00 | Pair |
| W0-08 | Graph DB concurrency instrumentation | 0 | W0-00 | AI agent |
| W1-01 | Multi-language Tree-sitter parsing module | 1 | W0-02 | AI agent |
| W1-02 | GitHub webhook receiver | 1 | W0-04, W0-07 | AI agent |
| W1-03 | AuthN/AuthZ middleware | 1 | W0-05, W0-03 | Pair |
| W1-04 | Next.js shell + React Flow base renderer | 1 | W0-01, W0-03 | AI agent |
| W1-05 | Ingestion/Delta Worker core | 1 | W1-01, W0-02, W0-04 | AI agent |
| W1-06 | GitHub App: registration, install flow & initial-parse trigger | 1 | W0-05, W0-07 | Pair |
| W2-01 | Sigma.js + graphology at-scale rendering | 2 | W1-04 | AI agent |
| W2-02 | Graph Query Service | 2 | W1-03, W0-02, W1-05 | Pair |
| W2-03 | WebSocket gateway + Redis pub/sub | 2 | W1-03, W1-05 | AI agent |
| W2-05 | Semantic Enrichment Worker skeleton | 2 | W1-05, W0-04 | AI agent |
| W2-06 | Tenant isolation enforcement | 2 | W0-02, W0-05, W1-03 | Human |
| W2-07 | Test node type + static COVERS inference | 2 | W1-01, W0-02 | AI agent |
| W2-08 | Onboarding-priority queue lane | 2 | W0-04, W1-05 | AI agent |
| W2-04 | Technical Tree end-to-end | 3 | W2-01, W2-02 | AI agent |
| W3-01 | Feature clustering | 3 | W2-05 | AI agent |
| W3-02 | Product Tree UI + Feature Cluster metadata panel | 3 | W3-01, W2-01 | AI agent |
| W3-03 | Graph-Guided RAG service | 3 | W2-02, W0-06 | AI agent |
| W3-04 | Git sync integration worker (provider-generic) | 3 | W1-02, W0-04, W0-02 | AI agent |
| W3-05 | Jira/Linear sync integration worker | 3 | W0-04, W0-05, W0-02 | AI agent |
| W3-06 | Coding/comment style tagging + folder inheritance | 3 | W2-05, W2-02 | AI agent |
| W3-07 | Model Provider adapter interface | 3 | W2-05, W0-07 | AI agent |
| W3-08 | Provider failure handling: circuit breaker & degraded states | 3 | W3-07* | AI agent |
| W3-09 | Chatbot & enrichment provider settings UI | 3 | W3-07* | AI agent |
| W3-10 | Jira OAuth connect flow (per-org, 3LO) | 3 | W0-05, W0-07 | Pair |
| W4-01 | Onboarding Tree + sandboxed setup exec | 4 | W3-01, W0-05, W2-08 | Pair |
| W4-02 | Interactive Node Overlay Panel + Agent/Skill MD dual-surface contract | 4 | W3-04, W3-05, W3-06, W3-01 | Pair |
| W4-03 | Dynamic COVERS refresh + test badges | 4 | W2-07, W2-04 | AI agent |
| W4-05 | DataLoader-readiness review | 4 | Waves 0–3 API tickets | AI agent (doc-only) |
| W4-06 | MCP Server surface (Agent Context Layer, read-only v1) | 4 | W2-02, W2-06, W1-03, W3-01, W3-06, W2-07, W3-04 | Pair |
| W4-07 | MCP local-model client interoperability verification | 4 | W4-06* | AI agent |
| W4-04 | Full RBAC & multi-tenancy hardening pass | 5 | W2-06, W2-04, W3-02, W4-01, W4-02, W4-06 | Human |
| W6-01 | Login OAuth browser-binding & CSRF fix | 6 | W1-03 | Pair |
| W6-02 | Auth-route input hardening & cache hygiene | 6 | W6-01* | AI agent |
| W6-03 | resolveUserByExternalAuthId production hardening | 6 | W1-03 | Pair |
| W6-04 | Structural org-scoped Cypher query enforcement | 6 | W2-06 | Human |
| W6-05 | Platform-wide rate limiting | 6 | W1-03 | AI agent |
| W7-01 | GitHub paginated reconciliation (removes the 25-repo cap) | 7 | W1-06 | AI agent |
| W7-02 | GitHub repo org-exclusivity enforcement | 7 | W1-06, W2-06 | Pair |
| W7-03 | Sub-5-second GitHub delta sync | 7 | W1-05, W2-03 | AI agent |
| W7-04 | Jira ticket-sync pipeline re-run & real-time sync | 7 | W3-05, W3-10 | Pair |
| W7-05 | Jira space/project org-scoping | 7 | W3-10 | AI agent |
| W8-01 | AI ticket-to-file matching: pipeline re-run & threshold tuning | 8 | W3-05, W2-05 | Pair |
| W8-02 | Ticket Inbox view | 8 | W3-05, W3-10, W8-01* | AI agent |
| W9-01 | Google OAuth2 login provider | 9 | W6-01 | Pair |
| W9-02 | Dedicated /login page | 9 | W9-01*, W6-01 | AI agent |
| W10-01 | Bucket data model & CRUD service layer | 10 | W0-02, W4-01 | AI agent |
| W10-02 | Drag-and-drop bucket builder UI | 10 | W10-01*, W2-01 | Pair |
| W10-03 | Bucket-scoped onboarding flow | 10 | W10-01*, W4-01, W2-08 | AI agent |
| W10-04 | Live-presence ingestion (open-branch activity) | 10 | W1-02, W3-04 | AI agent |
| W10-05 | Live-presence rendering on the Technical Tree | 10 | W10-04*, W2-01, W2-03 | AI agent |
| W10-06 | Auto-generate onboarding buckets from Feature Clusters | 10 | W3-01, W10-01* | AI agent |
| W10-07 | Decline action for auto-generated buckets | 10 | W10-02, W10-06 | AI agent |
| PM-01 | Macro View: Project entity + cross-repo edges | Post-MVP | W0-02, W3-04 | AI agent |
| PM-02 | Migration-trigger dashboard | Post-MVP | W0-06, W0-08 | AI agent |
| PM-03 | Neo4j → Amazon Neptune cutover | Post-MVP | PM-02 (threshold crossed) | Human |
| PM-04 | pgvector → Amazon OpenSearch cutover | Post-MVP | PM-02 (threshold crossed) | Human |
| PM-05 | GraphQL layer + DataLoader batching | Post-MVP | W4-05, product signal | Pair |
| PM-06 | Cursor Origin | Post-MVP | W3-04 (ingestion, gated); W4-06 (context, no gate) | AI agent, once gated |
| PM-07 | Env-file → KMS-backed secrets manager cutover | Post-MVP | W0-07 (external-customer trigger) | Human |
| PM-08 | MCP write/propose tool surface | Post-MVP | W4-06 (adoption + demand + reliability bar) | Pair |

**Total: 69 tickets** — 40 MVP-wave tickets (Waves 0–5, including W3-10), 21 post-launch hardening/capability tickets (Waves 6–10), 8 trigger-gated post-MVP tickets.

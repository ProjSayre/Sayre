# **Product Requirement Document** 

AI-Powered Codebase Ontology, Visualization, Agent Context & Model Provider Platform — Unified Edition v5 · July 2026 

## **Change Log** 

##### **v3 to v4:** 

1. **New capability — the Agent Context Layer (MCP Server).** The graph is exposed to external AI agents (Claude Code, Cursor, and eventually Cursor Origin) through a Model Context Protocol server. The interactive canvas remains the human surface; MCP becomes the agent surface over the same graph, service layer, and RBAC. See Sections 1.3, 2.6, 4.2. The Cursor Origin integration (Section 6) is inverted accordingly: this platform is the MCP _server_ ; agents are the _clients_ . 

2. **Resolved tooling decisions.** Sigma.js + graphology; REST first, GraphQL later behind a shared service layer; SQS for the Python worker fleet and BullMQ for Node integration workers; Neo4j first with a measured, trigger-gated cutover to Amazon Neptune; pgvector first with a measured, trigger-gated cutover to Amazon OpenSearch; env-file secrets for MVP with a trigger-gated cutover to a KMS-backed secrets manager. Triggers defined in Section 4.10. 

3. **Gap fixes.** The GitHub App authorization flow, the onboarding priority queue behind the TTFC target, graphdatabase concurrency instrumentation, the staged secrets posture, and the provider-generic Integration Worker requirement are stated explicitly. 

##### **v4 to v5 (this edition — supersedes the standalone “PRD Amendment v5”):** 

4. **New capability — Pluggable Model Provider Layer.** The Semantic Enrichment Worker and the Graph-Guided RAG chatbot no longer hardcode a call to the Claude API. An org selects Claude, GPT, or a self-hosted model as the model behind graph building and the AI chatbot. See Sections 2.7, 4.2, 4.3, 4.6, 4.10. 

5. **New capability — Local-Model Interoperability for the Agent Context Layer.** The existing MCP surface (Section 2.6) is verified and documented to work identically for a customer’s own agent running on a self-hosted model, with no new authorization path. See Section 4.11. 

6. **Structural vs. contractual data-sovereignty distinction (new in this edition, resolving a gap identified after the standalone amendment shipped).** Section 2.7 now states, as a testable requirement rather than an implied side-effect, that a self-hosted open-weight model configuration gives a _structural_ no-egress guarantee — no vendor server is ever in the request path — as distinct from the _contractual_ guarantee a hosted provider offers (a data-use policy governing a request that necessarily does leave the customer’s network). This distinction is now a verified property (Section 4.2, Model Provider Adapter) rather than an architectural implication left untested. 

## **1. Project Overview & Core Value Proposition** 

Modern development teams face massive friction when onboarding engineers, managing context switching, and aligning technical architecture with product objectives. Current tooling treats repositories as flat file structures or disconnected documentation. 

This platform is an AI-powered, context-aware codebase ontology and visualization web application. By parsing codebases into interactive, multi-dimensional knowledge graphs, the platform translates raw source code into tailored “tree maps” for different organizational stakeholders (technical, product, onboarding). It solves the “kitchen without labels” dilemma by mapping explicit code dependencies, task management tickets, ownership history, and required skills directly onto a visual graph canvas. 

The same knowledge graph that powers the human-facing canvas is also exposed as a live context layer for external AI coding agents (Section 1.3), and the models that build and query that graph are themselves swappable — including to models an organization runs entirely on its own infrastructure (Section 2.7). 

### **1.1 Target Audience** 

- **New Hire Engineers** — Accelerate time-to-productivity by visualizing branch-specific context, architectural dependencies, and onboarding workflows. 

- **Technical Leads & Architects** — Maintain a clear structural map of code semantics, identify ownership, track style adherence, enforce modular boundaries — and author the Agent/Skill MD rules that govern how AI agents may modify each part of the codebase. 

- **Product Managers** — Track feature shipping progress and map Jira/Linear tasks directly to real-world code components. 

- **AI Coding Agents** — Claude Code, Cursor, and other MCP-compatible agents — including a customer’s own agents running on self-hosted models — consume the graph as structured context: which nodes are relevant to a task, what rules govern them, which tests cover them, and who owns them. 

- **Security & Compliance Reviewers (new)** — Organizations with data-residency or vendor-exposure requirements evaluate the self-hosted model option (Section 2.7) as a structural, not contractual, guarantee that source code never leaves their environment. 

### **1.2 Macro View: Multi-Repo Architecture** 

Before any file tree renders, the platform supports a highest-level, multi-repo view of how work is actually organized across an engineering org. This Macro View is its own graph layer, sitting above the Unified File Skeleton (Section 4.3), and is what a viewer lands on before drilling into a specific repo’s Technical/Product/Onboarding Tree. 

- **Project-to-Repo Mapping** — A Project is a top-level organizational entity that can map to a single repository or span several. The Macro View renders Project nodes connected to one or more Repo nodes before any folder or file is shown. 

- **Inter-Repo Context** — Distinct repositories are connected by cross-repo edges, inferred from detected API contracts, shared package versions, and cross-repo import statements. 

Selecting a Repo node in the Macro View drills down into that repo’s Unified File Skeleton, preserving the same Technical/Product/Onboarding view toggle described in Section 2.2. See Section 4.3 for the Project/Repo node and edge additions to the graph schema. 

### **1.3 The Agent Context Layer** 

The strategic observation behind this addition: **the moat is the graph, not the agent.** Agent vendors will always ship better agent loops, faster. What they do not have is a queryable, semantically enriched, multi-tenant graph of a customer’s specific codebase — with ownership, tickets, tests, style rules, and per-node agent operating parameters already resolved. Rather than building a competing agent, the platform exposes its graph to _every_ agent through MCP — including agents built on a customer’s own models (Section 4.11). 

The two surfaces divide responsibility cleanly: 

- **The canvas is where humans understand and configure.** See the architecture, trace ownership, read feature descriptions — and author the Agent/Skill MD (Section 4.8) and folder-level style rules (Section 4.9) that govern agent behavior. 

- **MCP is where agents act.** An agent working in Claude Code, Cursor, or a customer’s own MCP client calls the platform’s MCP tools to find relevant nodes, pull bounded context, read the Agent/Skill MD for any node it intends to touch, resolve effective style rules, and identify covering tests — bound by the same RBAC and tenant isolation a human session is bound by. 

The MVP MCP surface is **read-only** . Write-path tools (agents proposing changes back through the platform) are post-MVP and trigger-gated (Section 7). 

## **2. Functional Requirements — with Required Tooling** 

### **2.1 Unified Graph-Based Repository Parsing** 

- **Multi-Language AST Parsing** — Map explicit structural relationships (function calls, class inheritance, module imports) via incremental syntax tree analysis. _Tooling: Tree-sitter, Python, language grammars (JS/TS/Py/Go to start)._ 

- **Semantic Relationship Extraction** — Analyze code semantics, config files, and inline documentation via LLMs to extract high-level functional groupings. Sayre's `GraphifyAdapter` wraps Graphify to constrain semantic output into graph primitives (nodes, edges, properties), while the `ModelProvider` boundary supplies the configured model. Graphify never replaces or changes W1-01's structural Tree-sitter parser. This makes the graph traversable by Retrieval and MCP regardless of which hosted or self-hosted model sits behind the call (Section 2.7). _Tooling: base Graphify, LangChain/LangGraph orchestration, Sayre adapters, Python/FastAPI._

- **Delta Processing** — Process code deltas incrementally on every push rather than rebuilding the entire codebase graph from scratch. _Tooling: GitHub Webhooks, Python, SQS._ 

### **2.2 Multi-View Interactive Tree Canvas** 

**Canvas Node Model** — Regardless of which view is active, the rendered canvas is built from exactly two node types: Folder (“F”) and File (including API endpoint files). Functions and classes are parsed and stored as graph data but never surfaced as their own canvas nodes. 

|**View**|**Target Users**|**Scope**|**Tooling**|
|---|---|---|---|
|Technical Tree|Architects, Core Devs|Syntax hierarchies, data<br>models, infra nodes, imports,<br>API routing paths|React Flow, Sigma.js (WebGL)<br>+ graphology, TypeScript|
|Product Tree|PMs, UX|High-level feature groupings<br>mapping files to user-facing<br>capabilities|React Flow, Next.js, Tailwind<br>CSS|
|Onboarding Tree|New Hires, DevOps|Sequenced setup workflows,<br>dependencies, required dev<br>environments per<br>service/branch|React Flow, Next.js API<br>routes, sandboxed shell<br>execution|



**Renderer decision:** React Flow renders small/medium graphs (under ~500 visible nodes); Sigma.js (WebGL) takes over above that threshold, chosen automatically based on a node-count signal from the backend. graphology handles clientside algorithm gaps behind a documented allowlist; RBAC filtering and deep traversal always remain server-side. 

### **2.3 Context & Metadata Labeling Engine** 

- **Ownership & Git History** — Automatically map previous contributors, recent editors, and primary code owners to specific nodes based on Git history. _Tooling: GitHub REST API, git log parsing, Node.js/TypeScript._ 

- **Coding Style & Guidelines** — Tag branches and folders with localized architectural expectations, styling rules, and design patterns. _Tooling: LLM classification via the pluggable model backend (Section 2.7), PostgreSQL metadata store._ 

- **Onboarding Automation** — Embed branch-specific onboarding tasks, pre-requisite reading, and executable local environment terminal setup commands inside node sidebars. _Tooling: Next.js, containerized/sandboxed runner, PostgreSQL._ 

### **2.4 Asynchronous Tooling Integrations** 

- **GitHub Integration** — Native GitHub App authorization capturing live commits, pull requests, and branch creations via webhooks. The GitHub App registration manifest, install/OAuth callback flow, installation-credential storage, and the trigger that kicks off the initial full-parse job are a first-class deliverable (Section 4.4’s cold-start flow has no entry point without it). _Tooling: GitHub Apps/OAuth, Webhooks, Node.js/TypeScript._ 

- **Task Management Integration** — Bidirectional syncing via Jira REST API and Linear API. _Tooling: Jira REST API, Linear API (GraphQL), Node.js/TypeScript, BullMQ._ 

- **Provider-Generic Git Integration (hard requirement)** — The git Integration Worker carries a provider field, a normalized event schema, and pluggable auth from its first version, so a second git-hosting provider (Cursor Origin, Section 6) is a plug-in rather than a pipeline rewrite. 

### **2.5 Persistent Memory & Token-Optimized RAG Architecture** 

- **Graph-Guided Retrieval** — Use the repository graph to pinpoint localized dependencies; the AI only retrieves code from nodes adjacent to the active file/branch, avoiding whole-repo dumps. This is the mechanism behind the 70x token-reduction KPI. _Tooling: LangGraph, Neo4j Cypher (openCypher-only, Neptune-compatible), a pluggable model backend (Section 2.7), Python/FastAPI._ 

- **Hybrid Storage Engine** — Split long-term memory across a transactional DB, a graph DB, and a vector store. _Tooling: Amazon RDS (PostgreSQL), Neo4j (Neptune later, Section 4.10), pgvector (OpenSearch later, Section 4.10)._ 

### **2.6 Agent Context Provision over MCP** 

The platform runs an MCP server exposing the graph to external, MCP-compatible agents. The v1 tool surface is readonly: 

|**MCP Tool**|**What it returns**|
|---|---|
|find_relevant_nodes(query)|Graph nodes most relevant to a natural-language task<br>description|
|get_node_context(node_id)|Bounded context for a node: description, structural neighbors,<br>key metadata|
|traverse_from(node_id, intent)|The bounded-hop neighborhood relevant to a stated intent|
|get_agent_skill_md(node_id)|The node-scoped Agent/Skill MD (Section 4.8): allowed tools,<br>required context, guardrails|
|get_style_rules(node_id)|The node’s effective Coding Style and Comment Style,<br>resolved through folder inheritance (Section 4.9)|
|get_covering_tests(node_id)|Test nodes linked via COVERS edges, with freshness/status<br>(Section 5)|
|get_feature_cluster(node_id)|The Feature cluster(s) the node belongs to, with member lists|
|get_recent_changes(node_id)|Recent editors, commits, and linked PRs scoped to the node|



Every MCP tool is a thin wrapper over the same service layer the REST endpoints call — no business logic lives in the MCP handler itself. Every call is authenticated (per-org scoped keys), RBAC-filtered, and tenant-isolated identically to a human canvas session. This holds regardless of what model or client software is on the agent side of the connection (Section 4.11). _Tooling: MCP over streamable HTTP, Node.js/TypeScript, existing Graph Query Service._ 

### **2.7 Pluggable Model Provider Layer (new in v5)** 

Every point in the platform that calls an LLM — the Semantic Enrichment Worker (feature clustering, style tagging, onboarding summaries) and the Graph-Guided RAG chatbot — sits behind a **Model Provider abstraction** rather than a hardcoded Anthropic call. An organization chooses its provider per-org, with three supported shapes: 

##### **Anthropic (Claude)** — the default. 

- **OpenAI (GPT)** — a second hosted option. 

- **Self-hosted / local** — a customer-supplied, OpenAI-compatible chat-completion endpoint (Ollama, vLLM, Text Generation Inference, or an equivalent serving layer), running on the customer’s own infrastructure or VPC. Because most local-model servers already expose an OpenAI-compatible API, one adapter — “OpenAI-compatible endpoint” — covers OpenAI itself and the large majority of self-hosted setups. This includes both a stock open-weight model (Llama, Mistral, Gemma 4, GLM-5.1, DeepSeek V4, or any future open-weight entrant) and a customer’s own finetune of one, run entirely on infrastructure the platform never touches. 

_Tooling:_ Sayre's `ModelProvider` owns generation-model selection, endpoint policy, and SDK/client construction. LangChain/LangGraph may orchestrate above that interface but is not the provider or security boundary. This remains one enrichment pipeline, selected by purpose-keyed org configuration.

Embedding inference uses a separate Sayre-owned `EmbeddingProvider`, never an embedding method added to generation `ModelProvider`. The first adapter lands with W1-05 and calls an OpenAI-compatible embeddings endpoint, using local-compatible `Qwen3-Embedding-0.6B` as the default. It returns exactly 1024 finite dimensions; CI uses a deterministic, network-free fake that emits stable 1024-dimensional vectors. Embeddings are asynchronous and therefore outside the structural-sync target.

#### **Structural vs. contractual data sovereignty (new in this edition)** 

This distinction is the actual substance of the self-hosted option’s value proposition, and it is stated here as a requirement, not left as an implied side-effect: 

- **Hosted providers (Claude, GPT) offer a contractual guarantee.** A request necessarily leaves the customer’s network and reaches the vendor’s infrastructure to be answered. The vendor’s standard terms govern what happens to that data once it arrives (e.g., not used to train future models by default) — but the code _did_ leave the customer’s environment, and the guarantee rests on trusting that policy. 

- **The self-hosted / local option offers a structural guarantee.** No vendor server is ever in the request path. There is no third party to trust a policy from, because there is no third party in the loop at all. This is an architectural property, not a promise — and it holds whether the model is a stock open-weight release or a customer’s own fine-tune, since either way the request never targets an address outside the customer’s own infrastructure. 

- **This structural guarantee is a verified, testable property of the platform (Section 4.2), not merely an architectural implication.** When an org is configured for a self-hosted provider, the Model Provider Adapter makes zero outbound calls to any Anthropic, OpenAI, or other third-party endpoint for enrichment or chatbot traffic. This is confirmed by a network-isolated test, not assumed from the design. 

##### **Known tradeoffs, stated for customers rather than glossed over:** 

Graphify’s output-shaping depends on the underlying model reliably producing structured output. Smaller or narrowly fine-tuned self-hosted models may produce noisier feature-clustering and style-tagging results than Claude or GPT — fine-tuning on a narrow internal codebase does not automatically improve JSON-schema-following, even 

where it improves domain understanding. 

- Latency and uptime for a self-hosted endpoint are the customer’s responsibility, affecting enrichment readiness and chatbot response time. They never affect the 15-second structural-sync target, which ends after graph commit and accepted `graph.updated` publication (Section 4.6).

- The enrichment worker and retrieval service apply a circuit-breaker/timeout pattern around self-hosted calls so a flaky customer endpoint degrades gracefully rather than blocking ingestion or the chatbot outright. 

## **3. Technical Stack & Infrastructure Architecture — Summary** 

|**Layer**|**Choice (resolved)**|**Purpose**|
|---|---|---|
|Frontend Framework|Next.js (React) + TypeScript|Visualization web app shell|
|Graph Rendering|React Flow (<~500 nodes) + Sigma.js<br>WebGL + graphology (above)|Node-based canvas at scale (1000s of<br>nodes)|
|Styling|Tailwind CSS|Dashboard layouts, context inspectors|
|Core API|Node.js/TypeScript, REST first; GraphQL<br>later over the same service layer|Auth, permissions, webhooks|
|Agent Surface|MCP server (streamable HTTP) over the<br>same service layer|Context provision to external agents,<br>including self-hosted-model clients|
|AI / Knowledge Graph Engine|Python FastAPI + Graphify + Tree-sitter<br>+ LangChain/LangGraph|Async repo parsing & semantic<br>extraction|
|Model Backend (new)|Pluggable: Anthropic, OpenAI, or self-<br>hosted OpenAI-compatible endpoint|Enrichment + chatbot model calls,<br>selected per org|
|Embedding Backend|Separate `EmbeddingProvider`; OpenAI-<br>compatible endpoint, Qwen3-Embedding-<br>0.6B local-compatible default|1024-dimensional cosine vectors,<br>selected per org|
|Message Bus|SQS/SNS (Python worker/event fleet) +<br>BullMQ on Redis (Node integration workers)|FIFO ingestion, fanout, priority<br>enrichment, async embedding upserts|
|Relational DB|Amazon RDS (PostgreSQL) with RLS|Orgs, users, permissions, billing, logs|
|Graph DB|Neo4j now; Amazon Neptune on<br>measured trigger (4.10)|Repository ontology|
|Vector DB|pgvector now; Amazon OpenSearch on<br>measured trigger (4.10)|Semantic code/doc chunk retrieval|
|Secrets|Env-file convention behind a single<br>loader module now; KMS-backed secrets<br>manager on customer trigger (4.10)|Credential handling|



## **4. System Design Architecture** 

Three principles drive every decision: 

- **The graph is the source of truth, not the repo.** Once ingested, all reads — canvas rendering, AI retrieval, integrations, MCP tool calls — hit the graph/vector/relational stores, never the raw git checkout. 

- **The write path and read path are fully decoupled.** Webhooks, parsing, and LLM enrichment happen asynchronously in workers; neither the frontend nor an MCP client ever blocks on parsing. 

- **Every consumer surface is a projection, not a separate dataset — and every model call is a swappable backend, not a hardcoded vendor.** The three persona views and MCP tools share one service layer. Generation, embedding, and semantic shaping use the separate Sayre-owned `ModelProvider`, `EmbeddingProvider`, and `GraphifyAdapter` interfaces.

### **4.1 Logical Architecture** 

The browser client (Next.js + React Flow/Sigma.js) talks to an API Gateway that enforces auth and RBAC, which routes to a Core App Service (Node.js) for fast synchronous reads/writes, and to a Realtime Service (WebSocket + Redis pub/sub) for live graph updates. An MCP Gateway sits beside the API Gateway, terminating MCP connections from external agents and routing thin tool handlers into the same Core App Service functions. Heavy work runs in a Python/FastAPI fleet: repository work arrives on an SQS FIFO ingestion queue; after an idempotent graph commit, accepted `graph.updated` events publish through SNS to independent realtime and enrichment subscriptions; only then do bounded chunks enter the physical `embedding-upserts` queue; enrichment uses separate physical onboarding-priority and default queues. Work queues have DLQs, visibility heartbeats, and durable idempotency/version checks. Node integration workers remain on BullMQ. Generation calls route through `ModelProvider`, embedding calls through the separate `EmbeddingProvider`, and semantic shaping through `GraphifyAdapter`. PostgreSQL, the Graph DB, and the Vector Store back all reads.

### **4.2 Component Breakdown** 

##### **Client — Next.js Visualization Shell** 

- React Flow renders small/medium graphs (<~500 visible nodes); Sigma.js (WebGL) takes over above that threshold. graphology fills client-side algorithm gaps behind a documented operation allowlist; it never performs RBAC filtering or deep traversal. 

The Technical/Product/Onboarding tabs re-issue a graph query with a different view parameter. 

Viewport-scoped querying: the client requests only nodes in the current viewport plus a one-hop buffer. 

- Live updates arrive over a WebSocket subscription per open project, patching the canvas in place. 

##### **API Gateway / Edge Layer (Node.js)** 

- AuthN via JWT/session validation; AuthZ middleware filters every request through RBAC before it reaches any data service. 

- REST facade for MVP; GraphQL added later over the same service layer when view-specific data-shape divergence forces overfetching or endpoint proliferation. Business logic is never written in route handlers, resolvers, or MCP handlers: the pattern is Route/Resolver/MCP-tool (thin) -> Service Layer (real logic) -> Graph Query Service -> Graph DB. 

##### **MCP Gateway (Node.js)** 

- Terminates MCP connections (streamable HTTP) from external agents; authenticates per-org scoped API keys; attaches the same { agentKeyId, orgId, roles } context the REST middleware attaches; dispatches to the same service-layer functions. Each key presents a public identifier/prefix and a 256-bit secret returned only at issuance. Postgres stores an HMAC-SHA-256 digest using a server-held, versioned pepper plus creation, expiry, last-use, and revocation audit fields—never the raw secret. Agent-key scope reuses the existing permissions model and can never exceed the issuing administrator's recorded issuance ceiling or current effective scope.

- Read-only tool surface at MVP. Every response passes through the identical server-side RBAC node-stripping applied to canvas queries. This holds identically for an Anthropic/Cursor client and for a customer’s own MCP client running a self-hosted model — no parallel authorization path exists for either (Section 4.11). Rate limiting and per-tool call metering from day one. 

##### **Generation and Embedding Provider Adapters (Node.js config / Python clients) — new**

- Purpose-keyed per-org `model_provider_configs` rows store provider, model, endpoint, and a pre-provisioned credential reference for generation or embedding. They never store a raw credential. Generation rows configure `ModelProvider`; embedding rows configure the separate `EmbeddingProvider`.

- Sayre-owned generation `ModelProvider` and `GraphifyAdapter` interfaces are consumed from the first enrichment implementation. W3-07 supplies Anthropic-native and OpenAI-compatible generation implementations (the latter covers hosted OpenAI and local servers) plus the base-Graphify implementation. Workers never construct a hardcoded vendor SDK client outside a provider adapter.

- `EmbeddingProvider` is a distinct interface with no dependency on `GraphifyAdapter`. W1-05 supplies its first OpenAI-compatible adapter, defaulting local-compatible deployments to `Qwen3-Embedding-0.6B`, and a deterministic network-free CI fake. Both must produce exactly 1024 finite values; persistence rejects any other dimension. W3-07 does not retrofit or absorb this embedding boundary.

- Endpoint credentials are resolved exclusively from pre-provisioned references through the secrets loader (Section 4.5)—no new secret-handling path. W3-09 cannot accept a raw credential before PM-07.

- A circuit-breaker/timeout wrapper around every self-hosted call, with a configurable fallback (retry, degrade to a visible “generating” state, or fail the specific job) chosen per org. 

- **When configured for self-hosted, the adapter is verified to make zero outbound calls to any third-party model endpoint** — the mechanism behind the structural data-sovereignty guarantee in Section 2.7, confirmed by a network-isolated test rather than assumed from the adapter’s design. 

##### **Core App Service (Node.js/TypeScript)** 

Handles org/user/permission management, node sidebar metadata assembly, and the Graph Query Service that translates viewport/view-filter requests into Cypher queries with RBAC-based node stripping. Kicks off async jobs onto the message bus rather than doing heavy work inline. 

##### **Realtime Service** 

A WebSocket gateway backed by Redis pub/sub for fan-out across multiple gateway instances; every push is refiltered through the receiving client’s RBAC scope before delivery. 

##### **Async Worker Fleet (Python + FastAPI)** 

- **Ingestion/Delta Worker** — clones or diffs the repo, runs Tree-sitter, and applies idempotent graph upserts for the next accepted repository/ref/revision. Before a delta it verifies the accepted revision is an ancestor of the incoming revision; a force-push or other non-fast-forward divergence triggers a full rebuild of the organization/repository/ref head projection instead of a changed-file delta. After the graph transaction commits, it publishes the accepted `graph.updated` event through SNS. Bounded chunks enter `embedding-upserts` only after that event, so the Technical Tree never waits on embedding/model latency. W1-05's separate embedding consumer calls `EmbeddingProvider` and writes validated vectors. The scratch clone is destroyed after parsing.

- **Semantic Enrichment Worker** — consumes accepted structural events on queues separate from ingestion; calls Sayre's `GraphifyAdapter` and configured `ModelProvider`, with optional LangChain/LangGraph orchestration above those boundaries. No provider is hardcoded, and Graphify constrains semantic output to graph primitives rather than parsing structural source.

- **Onboarding Priority Lane** — separate physical onboarding-priority and default queues, with priority-only capacity plus bounded weighted polling so onboarding completes first without permanently starving default work. Instrumented via

ttfc_cold_start_to_onboarding_ready_ms . 

- **Retrieval Service (Graph-Guided RAG)** — resolves an anchor node, traverses a bounded number of hops, pulls only the Vector Store chunks for that subgraph, and calls the configured Model Provider Adapter with a bounded context window — the mechanism behind the 70x token-reduction target, independent of which model backend answers the call. The same anchor-resolution and bounded-traversal primitives back the MCP tools find_relevant_nodes and traverse_from . 

##### **Integration Workers (Node.js)** 

- **Git sync (provider-generic)** — webhook receiver validates signatures, normalizes events onto the message bus, and updates ownership/PR/commit metadata directly on Graph DB node properties. Carries a provider field, normalized event schema, and pluggable auth from v1. 

- **Jira/Linear sync** — scheduled + webhook-driven bidirectional sync via a BullMQ-backed worker, mapping ticket IDs to file/feature nodes. 

### **4.3 Data Model** 

**Relational Store (PostgreSQL)** — organizations, users, repositories, permissions (scoped by org/repo/ref/path), ticket cache, style rules, onboarding steps, and the foundation datasets `github_app_installations`, audited org-scoped `mcp_client_keys`, purpose-keyed `model_provider_configs`, `repository_refs`, bounded tenant `code_chunks`, and `code_embeddings`. Provider rows store provider/model/endpoint and a pre-provisioned credential reference, never a raw credential. `repository_refs` records each mutable ref's accepted immutable revision and graph version. `mcp_client_keys` records a public key ID/prefix, HMAC-SHA-256 secret digest, pepper version, creator, creation/expiry, last-use, and revocation actor/timestamps; agent-key grants reuse `permissions` and enforce the issuer-scope ceiling. `code_embeddings` records tenant/repository/ref/revision/node/chunk identity, provider/model/dimension metadata, and a 1024-dimensional vector. Postgres is the auditable source for permissions and provider configuration. Every tenant table uses RLS, verified through the actual non-owner, non-superuser runtime role; service-layer authorization and RLS remain independent controls.

**Graph Store (Neo4j, logically Neptune-portable)** — Project, Repo, Folder, File, Function, Class, Module, Person, Commit, Feature, Ticket, EnvStep, Test node labels; CONTAINS, CONNECTS_TO, IMPORTS, CALLS, INHERITS, OWNS, AUTHORED, MODIFIED, REFERENCES, PART_OF, REQUIRES, DEPENDS_ON, COVERS edges. Repository identity is stable, refs are mutable, and revisions are immutable; scoped entities carry server-resolved org/repository/ref/revision identity. COVERS links Test to a covered node only within the same authorized scope, with nullable `last_run` and `status` of `inferred` or `measured`; Test carries `coverage_status` of `pass`, `fail`, or `unknown`. Logical schema, data migrations, and application queries are openCypher-compatible; constraints/indexes and other physical DDL are target-specific and versioned per target.

**Vector Store (pgvector, OpenSearch-ready)** — bounded tenant-scoped code/document chunks and 1024-dimensional embeddings keyed to originating graph nodes and revision identity. Similarity uses cosine distance and queries match provider/model/dimension metadata before comparison. These retrieval derivatives may persist; repository checkouts and source trees may not.

### **4.4 Key Flow Walkthroughs** 

**Initial Repository Onboarding (cold start)** — The user installs the GitHub App; the callback stores installation metadata and enqueues `repo.initial_parse` on the FIFO ingestion queue. Tree-sitter performs a full parse and the graph transaction commits. The accepted `graph.updated` event then fans out through SNS, making the Technical Tree available. Only afterward are bounded chunks dispatched on `embedding-upserts` and semantic work dispatched asynchronously; the physical priority lane schedules onboarding ahead of general enrichment. The embedding consumer uses the separate `EmbeddingProvider` and writes 1024-dimensional cosine vectors.

**Steady-State Push Event (the 15-second structural target)** — A validated push enters FIFO order for its organization/repository/ref. If the accepted revision is an ancestor of the incoming revision, the worker parses changed files and applies idempotent upserts/deletes. A force-push or other non-fast-forward divergence instead triggers a full rebuild of that organization/repository/ref head projection, removing structural state from the abandoned head. The worker commits and publishes `graph.updated` through SNS to independent realtime and enrichment subscriptions. `embedding-upserts` and LLM work start afterward and are outside the structural target.

**AI Query (Graph-Guided RAG)** — A user question against a node routes to the Retrieval Service, which resolves the anchor node, traverses a bounded number of hops, fetches only in-scope Vector Store chunks, assembles a bounded prompt, and calls the configured Model Provider Adapter — logging context tokens used versus a hypothetical full-repo count. 

**Agent Context Query over MCP** — A developer working in Claude Code, Cursor, or their own MCP client asks their agent to modify part of the codebase. The agent calls find_relevant_nodes , then per node calls get_agent_skill_md , get_style_rules , and get_covering_tests before proposing any change. Every tool call is logged with the org, the agent key, the node scope, and the tokens of context served — identically whether the agent runs on Claude, GPT, or a selfhosted model (Section 4.11). 

### **4.5 Security & Multi-Tenancy** 

- **Tenant isolation is structural, not just a WHERE clause:** org_id is stamped on every graph write and injected server-side on every query; the vector store uses per-tenant namespaces/indices; Postgres uses row-level security as defense-in-depth. 

- **Granular (node-level) access control** is enforced centrally in the Graph Query Service — unauthorized nodes are filtered server-side before leaving the server. The same filter applies to WebSocket fan-out and every MCP tool response. 

- **MCP credential posture:** agent access uses per-org scoped API keys created and revocable by org admins. Issuance produces a public key ID/prefix plus a 256-bit random secret returned once; Postgres stores only its pepper-versioned HMAC-SHA-256 digest and expiry/last-use/revocation audit data. Agent-key grants reuse the existing permissions model. Creation rejects scope broader than the issuer, and effective access remains the intersection of key permissions, its recorded issuance ceiling, and the issuer's current effective scope. All MCP traffic is metered per public key ID.

- **Model Provider credential posture (new):** through W3-09, provider configuration selects a pre-provisioned credential reference resolved exclusively by the secrets loader. Raw credentials are not accepted or stored. PM-07 supplies the later KMS-backed write/issuance/rotation phase. Switching provider remains an audited configuration change, not a deploy.

- **Data ephemerality:** the Ingestion Worker destroys its scratch clone after parsing. Structural metadata, bounded tenant-scoped code/document chunks, and embeddings may persist for retrieval; a checkout, source tree, or derivative that reconstructs one may not.

- **Secrets (staged posture):** MVP uses environment files behind a single loader module in each language. On the trigger defined in Section 4.10, the loader backend is swapped to a KMS-backed secrets manager and every previously issued secret is rotated. 

### **4.6 Success Metrics Mapped to Architecture** 

|**Metric**|**Target**|**Architectural Lever**|
|---|---|---|
|Token Optimization Rate|>= 70x reduction vs. full-repo context|Graph-Guided Retrieval structurally<br>bounds context to a traversal-derived<br>candidate set|
|Time-to-First-Commit (TTFC)|Reduce by 40%+|Onboarding Priority Lane on initial<br>ingestion, instrumented via<br>ttfc_cold_start_to_onboarding_ready_ms|
|Sync Latency|Canvas updates within 15s of webhook|Delta-only parsing, decoupled LLM<br>enrichment, WebSocket push|
|Agent Context Adoption|MCP tool calls per active org per week|MCP Gateway metering per key/tool|
|Agent Context Efficiency|Tokens of context served per agent<br>task, trending down|Per-call context-token logging on the MCP<br>Gateway|
|Provider Portability (new)|Feature-clustering and chatbot quality<br>remain within an acceptable band<br>across at least one hosted and one self-<br>hosted provider on a fixture repo|Model Provider Adapter tested against<br>Claude, GPT, and one open-weight self-<br>hosted reference model per release|
|Local-Client MCP Parity (new)|Zero behavioral divergence between an<br>Anthropic/Cursor MCP client and a<br>verified third-party local-model client<br>against the same tool calls|MCP interoperability test suite, run against<br>the published tool contract|
|Structural Data-Sovereignty Verification<br>(new)|Zero outbound calls to any third-party<br>model endpoint when an org is<br>configured for self-hosted|Network-isolated test of the Model<br>Provider Adapter’s self-hosted path|



### **4.7 Feature Cluster Visualization & Metadata Panel** 

Feature Clusters render as dashed boundary lines drawn around the set of Folder/File nodes the Semantic Enrichment Worker groups into a given Feature node. Clicking a boundary opens a metadata panel with four fields: Description, Team, Files Included, Recent Edits. Feature membership is also served to agents via the get_feature_cluster MCP tool. 

### **4.8 Interactive Node Overlay Panel (Node-Level Toggles)** 

Six independently toggleable layers per Folder/File node: Dependencies, Recent Changes, Specific Features, Agent/Skill MD, Description, Specific Tickets. **Agent/Skill MD is a dual-surface contract:** the canvas is its authoring surface (RBAC-gated, versioned, attributed); its two runtime consumers are the platform’s own Retrieval Service and external agents via the get_agent_skill_md MCP tool — identically whether that external agent runs on a hosted or self-hosted model. 

### **4.9 Folder-Level Topological Inheritance** 

Coding Style and Comment Style are tagged once on a Folder node, tracked as separate properties, and inherited by nested files unless overridden. Inheritance resolves top-down at query time in the Graph Query Service; the get_style_rules MCP tool returns the same resolved answer the canvas displays. 

### **4.10 Scaling & Migration Triggers** 

Every deferred migration is gated by a measured trigger, never a calendar date or customer count. 

|**Migration**|**Trigger**|**Measurement source**|
|---|---|---|
|Neo4j -> Amazon Neptune|Sustained multi-tenant concurrent load<br>against Neo4j crossing a defined<br>threshold|Graph-DB query instrumentation|
|pgvector -> Amazon OpenSearch|Sustained concurrent tenant queries/sec<br>(or p95 latency) crossing a defined<br>threshold|Vector-store instrumentation|
|REST -> GraphQL (+ DataLoader)|View-specific data-shape divergence<br>forcing overfetching or endpoint<br>proliferation|Endpoint/overfetch audit|
|Env-file secrets -> KMS-backed manager|First external customer or first<br>production pitch, whichever comes first|Business event|
|MCP read-only -> write/propose tools|Sustained MCP adoption baseline plus<br>explicit customer demand plus a defined<br>reliability bar|MCP Gateway metering|
|Customer-selectable provider, including<br>self-hosted (new)|Design-time boundary: `ModelProvider` and<br>`GraphifyAdapter` exist from first enrichment;<br>W3-07 supplies concrete implementations.<br>Availability is not load-gated.|N/A — initial-release architecture|
|Expanding supported self-hosted server<br>types beyond the OpenAI-compatible-<br>endpoint adapter (new)|Customer demand for a serving layer<br>that isn’t OpenAI-compatible|Support/sales request volume|



The concrete threshold values are defined and documented as part of the migration dashboard’s acceptance criteria. 

### **4.11 Local-Model Interoperability for the Agent Context Layer (new in v5)** 

The MCP Gateway (Section 4.2) is, by protocol design, agnostic to what powers the client on the other end of the connection. MCP defines the contract between an agent and a context server — it says nothing about the model driving that agent. A customer running an internal agent built on a self-hosted open-weight model (Llama, Mistral, Gemma 4, GLM-5.1, DeepSeek V4, or any future entrant, stock or fine-tuned) can be an MCP client against this platform’s tool surface exactly as Claude Code or Cursor’s IDE agent are today — same per-org scoped key, same RBAC-filtered responses, same tenant isolation, same metering. 

This is largely already true by construction; the requirement here is to verify and document it, not build a new authorization path: 

- **Interoperability verification** — a real test connecting a non-Anthropic, non-Cursor MCP client, built against a selfhosted open-weight model, confirming all v1 read-only tools function identically regardless of client identity. **Published tool contract** — the tool schemas defined in Section 2.6 are documented clearly enough for a customer’s engineering team to build their own MCP client without platform-team assistance. 

- **No change to auth, RBAC, or metering** — a locally-modeled agent authenticates with the same scoped API key as any other MCP client and receives identical RBAC-filtered, tenant-isolated results. 

## **5. CI/CD Test Impact Analysis** 

The graph carries first-class test topology so both humans and agents can reason about coverage: 

- **Test node type** — test files are parsed as Test nodes during Tree-sitter ingestion. 

- **Static COVERS inference** — COVERS edges inferred statically from imports at ingestion time. 

- **Dynamic COVERS refresh** — a nightly coverage-instrumented run refreshes COVERS edges with actual execution data; each edge carries nullable `last_run` and `status` (`inferred` or `measured`).

- **Pass/fail badge overlay** — the Technical Tree renders per-node coverage badges. 

- **Safe fallback** — when impact analysis cannot determine the affected test set with confidence, the full suite runs. 

- **Agent consumption** — the get_covering_tests MCP tool serves the same COVERS topology to external agents, hosted-model or self-hosted alike. 

## **6. Forward-Looking Integration: Cursor Origin** 

Cursor announced Origin, an agent-native git hosting platform, on June 16, 2026, positioned as a git-compatible alternative to GitHub built around AI agents as primary users of version control. As of this writing it remains waitlist-only, with general availability targeted for fall 2026, and no public API or webhook documentation has been released. 

### **6.1 Why It’s Relevant** 

With the Agent Context Layer, the strategically important relationship is: **this platform is the MCP server; Origin’s agents are clients.** An agent-native git host is, by definition, a host whose primary users need exactly the context this platform’s graph provides. Origin’s MCP extensibility means its agents should connect to this platform’s MCP surface the same way Claude Code and Cursor’s IDE agent do — and the same way a customer’s self-hosted-model agent does — with zero Origin-specific work on our side. 

The ingestion-side integration (Origin as a git provider feeding the graph) remains gated on Origin publishing public API/webhook documentation, and plugs into the provider-generic Integration Worker as a new provider. 

### **6.2 Recommended Approach** 

Keep the git Integration Worker provider-generic — a hard acceptance criterion. Do not build a concrete Origin ingestion integration until its API/webhook documentation is public. The MCP surface requires no Origin-specific work: it is client- and model-agnostic by protocol. 

## **7. Development Roadmap — Updated Plan** 

The six-sprint (~12 week) MVP plan is preserved. The Agent Context Layer and the Model Provider Layer are folded into Sprints 3-5; write-path MCP tools remain post-MVP and trigger-gated. 

|**Sprint**|**Weeks**|**Goal**|**Items added**|
|---|---|---|---|
|Sprint 0|1-2|Foundations & infra skeleton|Test node + COVERS edge in<br>initial schema; secrets loader<br>convention; graph-DB and<br>vector-store concurrency<br>instrumentation; dependency<br>baseline|
|Sprint 1|3-4|Repository parsing pipeline|Parse test files as Test nodes;<br>static COVERS inference;<br>GitHub App registration +<br>install flow|
|Sprint 2|5-6|Technical Tree Canvas (MVP<br>UI)|Onboarding priority queue<br>lane (TTFC lever)|
|Sprint 3|7-8|Semantic layer & Product<br>Tree|Model Provider Adapter<br>(Anthropic/OpenAI/self-<br>hosted), circuit-breaker<br>handling, provider settings UI|
|Sprint 4|9-10|Integrations: GitHub, Jira,<br>Linear|Provider-generic git<br>Integration Worker; MCP<br>Gateway scaffold + first read-<br>only tools|
|Sprint 5|11-12|Onboarding Tree, permissions<br>& hardening|Dynamic COVERS refresh +<br>badges; Agent/Skill MD dual-<br>surface contract; full MCP<br>read-only tool set; local-<br>model MCP interoperability<br>verification; structural data-<br>sovereignty network-isolation<br>test; hardening pass<br>extended to cover the MCP<br>and Model Provider surfaces|



**Post-MVP (trigger-gated, per Section 4.10):** Macro View; migration dashboard with defined thresholds; Neo4j -> Neptune cutover; pgvector -> OpenSearch cutover; GraphQL + DataLoader; env-file -> KMS secrets cutover; Cursor Origin ingestion provider plug-in; MCP write/propose tool surface; expanded self-hosted server-type support beyond OpenAI-compatible; expanded language coverage; additional task-tracker integrations; collaborative annotations; admin 

billing console. 


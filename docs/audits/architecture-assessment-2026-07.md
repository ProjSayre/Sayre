# Architecture Assessment — July 2026

**Status:** working assessment, produced at the point where Ticket Backlog v3 (waves 0–4) is
substantially landed and the next phase of work is being chosen.
**Method:** six parallel subsystem audits read the actual code (not the docs) and recorded every
claim with a `file:line` citation; four cross-cutting gap lenses re-verified known issues against
current `main` rather than trusting older notes; the eight highest-severity findings were then
handed to independent adversarial verifiers instructed to *refute* them. **All eight were
CONFIRMED — none refuted.** Five further researchers scanned the July-2026 landscape via live
web search (Part 3).
**Scope note:** this is an architecture-level assessment. It records what exists, what diverges
from the documentation, and what is missing. It does not prescribe positioning — Part 4 states
only what the evidence constrains.

---

## Part 0 — The one-paragraph version

The engineering is better than the operations by a wide margin. Security-critical internals —
tenant isolation, the secret catalog, MCP key design, webhook validation, the per-push RBAC
re-filter — are unusually rigorous for an MVP and hold up under adversarial reading. What does
not exist is everything required to *run* the thing: no container build for any of the four
services, no deploy target, no bootstrap document, no backup, no end-to-end test, and no working
measurement for any headline KPI. The product also has three functional bugs on the first-run
path that a design partner would hit within an hour. The single most urgent item is not
architectural at all: a working-tree file holding live credentials, including the JWT signing key
that mints sessions for any tenant.

---

## Part 1 — The architecture as built

### 1.1 What actually exists

**`apps/web`** — Next.js 14. One `WorkspaceShell` drives three registry-declared views
(Technical/Product/Onboarding) over a single `WorkspaceProvider` state machine, with a
live/fixture `WorkspaceDataSource` split so the same UI runs against core or against a
hand-authored fixture lab at `/mock`. Live reads pass through allowlisted BFF proxy routes to
`CORE_INTERNAL_BASE_URL`. Strict runtime parsers reject any payload not marked
`authorization: 'server-filtered'` and any edge referencing a filtered-out node — a genuinely
good trust boundary. Rendering is React Flow by default, with Sigma.js/graphology only for the
Technical view above 501 visible nodes.

**`services/core`** — a disciplined Express monolith whose layering rules actually hold: routes
are thin, enforced by an ESLint import ban plus a `lintGate.test.ts` that asserts the ban fires.
All Neo4j access funnels through two guarded executors behind a lexical org-scoping guard and an
import-allowlist chokepoint test. Postgres tenancy runs through FORCE RLS with a
`SET LOCAL ROLE` + `app.org_id` GUC wrapper, with four narrow `SECURITY DEFINER` resolvers for
pre-tenant reads. It also hosts the entire MCP gateway (9 read-only tools, HMAC-peppered keys
whose scope is the intersection of issuance grants and the issuer's live permissions).

**`services/workers`** — four separately-run CLI consumer processes (ingestion,
enrichment-default, onboarding-priority, embedding) over a hardened SQS/SNS layer with FIFO
ordering, visibility heartbeats, durable idempotency claims, and graph-version watermarks.
Ingestion does scratch-clone → Tree-sitter parse → one Neo4j transaction → Postgres
compare-and-set ref accept → SNS `graph.updated`, with force-push correctly forcing a full
rebuild and guaranteed scratch destruction.

**`services/gateway`** — SQS long-poll → Redis pub/sub fan-out → one Core
`/internal/realtime/graph-delta` call *per connection per event*, forwarding that client's own
token so Core re-runs authentication and RBAC-scoped Cypher on every push. The per-push
re-filter rule genuinely holds for the delta path and is proven by an in-process e2e test.

**Data layer** — 17 Drizzle-defined tenant tables all carry ENABLE+FORCE RLS with an identical
`org_isolation` policy. Both language stacks share a closed 21-name secret catalog that exactly
matches `SECRETS.md` and rejects unknown names before any lookup. Ten of the thirteen documented
Neo4j labels are actually populated.

### 1.2 Strengths worth protecting

These came through adversarial reading intact, and several exceed what the founder decision log
credits:

- **Tenant isolation testing.** Live-Postgres RLS suites across 14 tables plus a Python
  cross-store penetration suite whose *negative control* proves the older
  `set_config`-without-`SET ROLE` pattern leaks under a privileged DSN.
- **Anti-silent-skip CI.** Required-broker flags, a JUnit zero-skip assertion, and admin-DSN
  plumbing that defeats Turbo's env stripping so the isolation tests cannot quietly skip.
- **MCP key design** — verified sound end to end by a verifier trying to break it: one-time
  256-bit secret, pepper-versioned HMAC digest, grants as `permissions` rows, scope ceiling
  enforced against the issuer's live scope.
- **Webhook signature validation** — verified complete and correctly ordered on every inbound
  path.
- **Self-hosted egress posture** — `trust_env=False`, `follow_redirects=False`, no-fallback
  `base_url` on the OpenAI-compatible adapters. This is real substance behind the sovereignty
  claim, not a slogan.
- **The graph org guard + chokepoint + static Cypher scan trio**, whose header records three
  consecutive adversarial bypass rounds.

### 1.3 Documentation divergences — read this before revisiting decisions

Twelve places where a tracked document describes something the code does not do. These matter
because several strategic decisions were taken partly on the strength of these documents.

| Document claims | Reality |
|---|---|
| `CLAUDE.md`: Sigma.js + graphology "at every scale" | React Flow is primary for all three views; Sigma only for Technical above 501 nodes. `docs/architecture.md` is correct here; `CLAUDE.md` is not. |
| `CLAUDE.md`: `npm run dev/test/lint` at root | Root package is the **Vite marketing site** (`sayre-site`). Root `test` and `lint` scripts do not exist; the workspace variants are `*:workspaces`. The mandated verification sequence is unrunnable as written. |
| `CLAUDE.md`: `packages/graph-schema` = "openCypher schema + query builders" | One markdown file. No code, no `package.json`. |
| `CLAUDE.md`: workers use "LangChain/LangGraph" | Never imported anywhere. Pinned dead dependencies; the retrieval boundary test actively forbids importing them. |
| `CLAUDE.md`: workers are "Python/FastAPI" | FastAPI is a two-route health stub. The fleet is argparse CLI processes consuming SQS. |
| `CLAUDE.md` structure for `services/core` | Omits the MCP gateway entirely — a whole external protocol surface. |
| `architecture.md`: Graph-Guided RAG resolves an anchor, fetches bounded chunks, calls a ModelProvider | The live Node path is **lexical** term matching plus a 2-hop structural walk. No chunk fetch, no ModelProvider call. The Python `RetrievalService` that does implement this is fully built and tested but **has no production entrypoint**. |
| `CLAUDE.md`: SQS/BullMQ split is "permanent" | Holds on the consume side. Node core now *produces* onto two Python-fleet SQS queues (`ingestion.fifo`, and `enrichment-default` via the hand-built ticket matcher). |
| Pipeline docs: `review`/`security-checker` are "read-only, enforced by hook" | **False.** The hook matches only `Write`; both agents carry `Bash`, which is an unguarded write path. (Decision log D-005 caught this; it is still open.) |
| PRD: canvas updates within 15s of webhook | The PRD defines this target two different ways in two places, and neither is measured anywhere. |
| `schema.md`: 13 node labels; `agent_skill_md` on graph nodes | 10 labels populated; `Project`/`Repo`/`Module` are sentinel anchors only; `CONNECTS_TO`/`DEPENDS_ON` have no writer. Agent/Skill MD lives exclusively in Postgres, never on a graph node. |
| `docker-compose.yml`: images "pinned exactly" | Four of five tags float at patch level; nothing is digest-pinned — while the project's own sandbox policy rejects mutable tags. |

---

## Part 2 — The gap register

64 findings: **18 high, 31 medium, 15 low**. Two previously-suspected issues were checked and
found **sound** (MCP scope escalation, webhook validation ordering) and are recorded as
non-findings. Grouped by theme below; the eight marked ✅ were independently verified by an
adversarial refutation pass.

### Theme A — Credential exposure (do this first, today)

**A1 · Live credentials in an un-gitignored working-tree file.** ✅ *(effort: S)*
`infra/New Text Document.txt` contains a GitHub App RSA private key, client secret, webhook
secret, Jira OAuth secret and token-encryption key, Anthropic and OpenAI API keys, database
passwords — and critically `JWT_SIGNING_KEY` and `MCP_TOKEN_PEPPER`. `git check-ignore` exits 1:
**nothing in `.gitignore` covers it**; `.gitignore` matches only `.env*`, `*.pem`, `*.key`. The
file's own header claims the values are throwaway, which is contradicted by the real GitHub App
slug/ID and live ngrok callback URLs inside it.

Why this outranks everything else: `JWT_SIGNING_KEY` signs the HS256 session tokens that carry
`org_id` and roles. Anyone holding it can mint a valid session for **any tenant**, bypassing
every RLS policy, graph guard, and RBAC filter documented in Part 1.2 — the entire isolation
story is downstream of that one secret. The repo directory is also OneDrive-synced, so the blast
radius already extends off-machine.

*Remedy:* move the file out of the repo tree, **rotate every value in it**, switch `infra/` to an
allowlist-style ignore rule, and add a pre-commit secret scanner so filename-shaped gaps stop
mattering.

**PL-15 redaction note:** the full per-secret inventory this finding summarizes (exact variable
names, file/line locations, masked values) lives in `deep-audit-2026-07-31/audit-15-secrets-deps.md`
§C-1, where exact line numbers and per-secret liveness confirmation have been generalized out of the
tracked table and remain on file only in the auditor's untracked working copy.

### Theme B — Nothing is deployable or operable

- **B1 · No Dockerfile for any of the four services.** ✅ *(M)* Compose runs datastores only.
  This blocks Render/Fargate, any Helm chart, image scanning, and reproducible builds. Everything
  else in this theme is downstream of it.
- **B2 · No CD, no deploy target, no IaC.** ✅ *(L)* The entire SQS/SNS/DLQ topology — FIFO
  queues, fanout, redrive counts, retention — exists **only** as a LocalStack bash script.
  Standing up real AWS means reverse-engineering it by hand.
- **B3 · No backup, dump, or restore tooling for any store.** ✅ *(M)* Durability is three Docker
  volumes. There is a live correctness hazard here: a Postgres point-in-time restore rewinds
  `graph_version` against a newer Neo4j graph, breaking the anti-rollback compare-and-set
  premise, and resurrects soft-revoked credential rows.
- **B4 · No bootstrap or ops runbook.** ✅ *(M)* Running the full product requires ~10 hand-started
  processes; `dev:workspaces` starts three of them. The verifier found the boot sequence is
  documented *literally nowhere* — even the untracked `AGENTS.md` covers only marketing-site
  commands.
- **B5 · Supporting gaps** *(mostly S)*: no concurrency group/caching/path filtering in CI and
  every PR double-runs; no Dependabot, dependency audit, or SBOM; version frozen at `0.1.0`
  despite a published customer-facing MCP contract; no structured logging or correlation IDs;
  health endpoints are liveness-only; no alerting.

### Theme C — Security debt blocking outside users

- **C1 · WEB-04 login CSRF / session injection, still fully open.** ✅ *(S)* No browser binding
  anywhere: no cookie set at `/auth/github/login`, none checked at the callback; the state JWT's
  nonce is signed but never stored or compared. An attacker can get a victim's browser to
  complete the attacker's login flow, silently placing the victim inside the attacker's tenant.
  The repo itself labels this "must close before any real external user relies on this login
  path" — **which is exactly what a playable product is.** ~30 lines to fix.
- **C2 · Production login would mint duplicate orgs.** ✅ *(M)* `resolveUserByExternalAuthId`
  works today only because the local DB role is a superuser bypassing RLS. Under the production
  `NOBYPASSRLS` role it returns nothing, so **every sign-in looks like a new user and creates a
  new org** — a returning user silently loses their workspace. Three sibling resolvers already
  exist as `SECURITY DEFINER` functions; this one was never built.
- **C3 · Python RAG retrieval store uses the leaking pattern** *(S)*. `retrieval/store.py` still
  uses session-scoped `set_config` without `SET LOCAL ROLE` — the exact pre-W2-06 posture the
  repo's own penetration test proves leaks. Every other Postgres consumer was migrated; this one
  was missed.
- **C4 · Jira poll idempotency key omits org and repository** *(S)*. Cross-tenant job
  suppression, not merely a dedup bug (see D2).
- **C5 · Realtime resync frames bypass the per-push RBAC re-filter** *(M)*. Subscribe accepts any
  `repoId` and the full-rebuild path returns `resyncRequired` with no read-scope check, leaking
  update-activity metadata for repos the member cannot read.
- **C6 · Others** *(S–M)*: no security headers on either surface; no rate limiting anywhere on the
  public API including auth and webhooks; 12-hour stateless sessions with no revocation path; dev
  auth backdoor gated only by `NODE_ENV`; Linear credentials still instance-global (the exact
  defect W3-10 fixed for Jira); `graphOrgGuard` Gap 7 unchanged.

### Theme D — Functional bugs on the first-run path

These are the ones that decide whether someone can "play around without encountering bugs."

- **D1 · No working embedding provider path exists.** ✅ *(S)* Hosted OpenAI hard-fails the
  1024-dimension gate into a **DLQ poison loop** because `embed()` never passes the `dimensions`
  parameter; the endpoint catalog blocks loopback, so a laptop-local model cannot be registered
  either. Consequence: semantic embeddings, RAG chunks, and AI ticket-to-file matching have
  **never run against a real model**. The 0.75 similarity threshold is untuned against real data.
  Every AI feature that would carry a demo is currently a placebo.
- **D2 · Jira multi-repo sync is broken.** *(S)* The BullMQ `jobId` derives from a key lacking
  `repositoryId`, so for a two-repo org all repos after the first collide and BullMQ silently
  drops their jobs — **one repo per org gets each ticket per cycle**. The existing test mocks the
  enqueue call, so it encodes the same wrong assumption the code makes.
- **D3 · Deleting a file never updates the canvas.** *(M)* `getAffectedNodes` always returns
  `removed: []`, so a deletions-only push produces an empty delta, and fan-out sends nothing when
  upserts are empty. The deleted file keeps rendering until an unrelated event or manual reload.
- **D4 · No reconnect backfill.** *(M)* After a WebSocket reconnect the client only flips a status
  badge; anything missed while disconnected leaves the canvas **silently stale**. A related
  comment in `pubsub.ts` incorrectly claims SQS redelivery covers Redis subscriber gaps — it does
  not: `PUBLISH` succeeds with zero subscribers and the message is then deleted.
- **D5 · First-run polish** *(S each)*: an onboarding-tree 404 renders as "Sayre is unavailable
  right now" (likely on a freshly imported repo, possibly while the banner says "generating");
  the account menu shows hardcoded placeholder identity because no `/me` endpoint is proxied; the
  25-repo install cap silently drops repos beyond the cap.

### Theme E — No evidence apparatus for any headline claim

- **E1 · The 70x token-reduction KPI is unmeasurable.** ✅ *(M)* The only code that computes the
  ratio lives in the Python `RetrievalService`, which has **no production entrypoint**, and the
  live agent-facing Node path counts zero tokens. No bench script exists. If a design partner or
  investor asks to see the number on a real repo today, there is no way to produce it.
- **E2 · The 15-second sync target is measured nowhere end-to-end.** *(M)* The one timing signal
  produced is worker-internal and consumed by nothing. A regression to 30s+ would first surface
  in a live demo.
- **E3 · MCP metering records into a no-op meter.** *(M)* `services/core` never installs a
  MeterProvider or exporter, and no durable usage ledger exists — so the "metered tool surface"
  has no number to show and nothing to bill from. This is also the metric that gates PM-08.
- **E4 · TTFC is emitted into a void** *(S)*: `cli.py` never calls `init_metrics()`, and the
  fallback log line is dropped by the default logging config. One small change fixes TTFC, vector,
  and graph metrics for all four worker modes.
- **E5 · Provider Portability has no harness at all** *(L)*; **Structural Sovereignty
  verification** is real and CI-blocking but covers only the enrichment path, not the embedding or
  retrieval lanes *(S)*.

### Theme F — Testing seams

- **F1 · No automated test crosses any process boundary of the webhook→canvas chain.** *(L)*
  ~190 unit test files, no integration tier, zero E2E — a barbell. Every seam where a real bug has
  already been found (D2, D3, D4) is precisely a seam no test crosses.
- **F2 · Neo4j is entirely absent from CI** *(M)*. Every live-graph test permanently skips, so no
  Cypher — including all RBAC-scoped canvas queries — has ever run against a real graph in
  automation. The store that enforces RBAC is the one store CI never boots.
- **F3 · `@sayre/gateway` has zero CI coverage** *(S)*. Its 10 test files include the codebase's
  best security artifact (the per-push re-filter proof) and never run on push or PR. Three lines
  of workflow fix this.
- **F4 · No browser E2E anywhere** *(M)* — no Playwright, no Cypress, not even jsdom. The
  deliberate `/mock` fixture lab makes a Playwright suite unusually cheap and is sitting unused.
- **F5 · Mock-at-the-seam testing already hid a shipped bug** *(S)* — see D2. Also: no code
  coverage measurement in any language, so these blind spots were invisible; the zero-skip gate
  protects only two messaging files.

---

## Part 3 — The July-2026 landscape: what to adopt, watch, ignore

Five research lenses, all via live web search (the assistant's training data predates most of
this). They converge on one picture. The parse-repo-into-graph-and-serve-over-MCP pattern Sayre
implements has become the consensus architecture — and, at the single-player level, a free
commodity — while MCP itself consolidated under the Linux Foundation and shipped a **stateless
spec revision on 2026-07-28** (two days before this research) that fits Sayre's server-side
`org_id`/RBAC model almost exactly. In parallel, a CVE-backed MCP incident record, named
governance frameworks, and standardized AI vendor questionnaires have made "governed agent access
to context" an explicit buyer category, and **no surveyed vendor yet claims database-level
structural tenant isolation at the context layer.** Sayre's data-layer picks survive contact with
the landscape, though two written migration assumptions need revision.

### 3.1 Competitive landscape

"Codebase context for agents" went from niche to crowded in nine months. Two OSS local-first
graph builders — **CodeGraph** (~63.6k stars, MIT) and **GitNexus** (~44.8k stars) — exploded in
early 2026 and both are commercializing. **Augment Code** unbundled context as a standalone
metered MCP product for "any agent" (GA 2026-02-06, $252M raised) — this is positioning A's exact
phrase, already occupied and better funded. Incumbents wrapped context in governance:
Sourcegraph's Enterprise-only MCP server enforces code-host permissions, GitHub shipped
Enterprise AI Controls to GA, and Harness publicly argues that agent queries must respect
permissions "at the graph query level" — fork B's argument, made verbatim by a public company.

Findings that matter most:

- **GitNexus / Akon Labs (YC S26)** is the closest competitor to Sayre's shape — Tree-sitter
  parsing, embedded graph DB, 17 MCP tools including impact/blast-radius and trace, now
  converting OSS traction into a managed enterprise track. Treat as the primary competitive
  benchmark; differentiate on what it lacks publicly: `org_id`-stamped tenancy, server-side RBAC
  filtering, metered governance.
- **Symvanta** is a near-clone of Sayre's architecture *and* security posture — multi-tenant
  hosted graph MCP, OAuth, per-tenant isolation, the same discard-source-after-parse promise —
  and is **already selling while Sayre is deployed nowhere**. Founding and funding unverified.
  Proof the wedge is investable, and that there is no time moat.
- **OSS long-tail commoditization** (Serena, claude-context, Repomix at 26.2k stars, a dozen
  others) covers every single-user sub-capability at price zero; none offer tenancy, RBAC, or
  metering. The implication the researchers draw: **Sayre's paying customer is the organization,
  not the individual developer.**
- **Cursor/Anysphere is being acquired by SpaceX ($60B, 2026-06-16)**, alongside the Origin
  agent-native git host. The consolidation hands fork B a live neutrality narrative for buyers who
  do not want their code's semantic index owned by a model/editor/hosting conglomerate.

### 3.2 The MCP ecosystem

The protocol consolidated hard: MCP, AGENTS.md, and goose now sit under the Linux Foundation's
**Agentic AI Foundation** (~49 member orgs), which de-risks Sayre's single biggest architectural
bet. Every major client surface speaks MCP natively, so one remote endpoint reaches all of them.

- **Spec revision 2026-07-28 — target this directly.** Sessions and the `initialize` handshake are
  removed; identity, version, and capabilities travel in `_meta` on every request; cross-call
  state becomes an explicit server-minted handle. This *is* Sayre's architecture — org scope
  derived server-side per request, no session affinity. Because nothing is deployed, Sayre can
  build against the new revision and skip the stateful legacy entirely, which is a real advantage
  of being late.
- **`Mcp-Method`/`Mcp-Name` headers + cacheable tool lists** make per-tool metering and rate
  limiting header-level operations — purpose-built for what Sayre's gateway already does.
- **Auth has settled:** OAuth 2.1 resource servers with audience-bound tokens; Client ID Metadata
  Documents replace Dynamic Client Registration (formally deprecated 2026-07-28).
- **A heavy incident record** — 40+ MCP CVEs in 2026 (count unverified), an OWASP MCP Top 10,
  CVE-2025-6514 at CVSS 9.6 — has made "governed MCP access" a recognized buyer category. Sayre's
  design already matches most recommended controls; named gaps are signed/immutable tool
  descriptions, per-call audit logs as a customer-facing feature, and injection-aware handling of
  graph-derived output.
- **Versioning norms:** practitioner consensus treats the tool surface as a versioned contract —
  immutable definitions per version, contract snapshots diffed in CI, and **description text
  counted as breaking** because it silently changes agent behavior. Cheap now, near-impossible to
  retrofit once customers tune agents against the surface.
- Reserve a domain-verified namespace in the official registry (still preview) against documented
  squatting patterns.

### 3.3 Data layer

Core picks hold; two written assumptions need revision.

- **Neo4j Community is unchanged** (GPLv3, CalVer 2025.x). Pin Cypher 25 explicitly and restrict
  the query surface to GQL-mandatory-conformant constructs — this turns the fuzzy portability
  convention into a checkable rule.
- **The pgvector → OpenSearch trigger needs rewriting.** pgvector 0.8.6 shipped 2026-07-29;
  iterative index scans fix exactly the org-filtered ANN case Sayre runs, and pgvectorscale pushes
  the practical ceiling to ~50M vectors per node. Insert pgvectorscale as the intermediate step
  and move OpenSearch out to "hybrid BM25+vector or >50M vectors/node." **Leaving Postgres means
  leaving the RLS boundary** and hand-rolling a second tenant-isolation layer — a real cost.
  Switch to `halfvec(1024)` before data exists.
- **Kuzu died** — abandoned October 2025 after Apple acquired Kuzu Inc. Do not build on the forks;
  keep the episode as the vendor-risk argument for the conservative Neo4j pick.
- **FalkorDB** offers native multi-graph tenancy (10,000+ isolated graphs per instance) — a
  structurally stronger isolation primitive than org-stamped rows in one database. Do not migrate
  pre-revenue; name it in `docs/migration-triggers.md` and run a one-day dialect spike.
- **Embeddings: the local default holds.** Qwen3-Embedding-0.6B has not been leapfrogged at its
  size. Benchmark `jina-code-embeddings-0.5b` against it **before first customer data is
  embedded** — afterwards it becomes a versioned re-embedding migration. OpenAI embeddings are
  stagnant and code-inferior.
- **Keep the parsing tier.** GitHub archived stack-graphs (even they couldn't sustain precise
  nav), and the OSS Tree-sitter-MCP swarm proves the architecture is consensus while none of it is
  multi-tenant, incremental, or production-grade.

### 3.4 Methodology and eval tooling

- **TDAD is confirmed and citable** (arXiv 2603.17973): a code-test dependency graph cut agent
  regressions 6.08% → 1.82% on SWE-bench Verified and raised resolution 24% → 32%, while
  procedural TDD prompting *alone* made regressions worse (9.94%). Academic backing for "context
  beats procedure." No published replications as of 2026-07-30. A `tests_at_risk` tool is nearly
  free on Sayre's existing graph.
- **The 70x claim needs rescoping — this is the most consequential landscape finding.**
  ContextSniper's rigorous harness (matched tasks, two host agents, tokens + cost + unchanged
  resolution rate, public harness) produced **1.5–2x savings, not 70x**. Independent reproducers
  (pantheon-org) publicly downgraded a competitor's 99.2% claim for using a naive-grep baseline
  and non-runnable methodology. Every vendor deck already claims 95–99%, so the number no longer
  differentiates. Sayre's opportunity is to be **the only measured claim** — scope it to specific
  query classes, publish the harness, and expect the figure to compress under honest measurement.
- **Loop engineering** was formalized publicly in June 2026 and merged into Spec Kit; Sayre's
  pipeline independently reinvented it. Named gaps: an explicit loop-contract artifact, a
  comprehension-debt sweep, per-run budget caps, an evidence-based sampling policy.
- **"Comprehension debt"** was coined March 2026 and Forbes-legitimized by July, with an RCT
  showing AI-assisted engineers scoring 17 points lower on comprehension. Sayre's Onboarding view
  and canvas are a direct antidote to a named pain with no category-defining product attached.
- **Eval tooling:** promptfoo (acquired by OpenAI 2026-03-09, note the neutrality asterisk) for
  CI red-teaming — prompt injection via repo content is Sayre's top product attack surface — plus
  DeepEval, which drops into the existing `poetry run pytest` loop. Keep datasets portable.

### 3.5 Security and compliance

The evidence supports Position B, with a sequencing caveat.

- **SOC 2 Type II is a procurement gate**, but buyers accept a documented interim path a seed
  company can reach: Type I plus an observation window, an engagement letter, a one-page security
  overview, and CAIQ-Lite responses. 2026 questionnaires additionally ask for AI data-handling
  policy, prompt-log retention, and audited LLM subprocessor chains — Sayre's existing rules
  (scratch clone destroyed, only metadata and embeddings persisted, no secrets in logs) are strong
  answers that are **currently undocumented**.
- **CSA AI Controls Matrix v1.1 + AI-CAIQ (2026-06-22)** — 247 control objectives, with a STAR
  Level 1 self-assessment that costs time rather than money. The cheapest third-party-recognized
  attestation an unfunded AI vendor can hold. Do it before writing any marketing that says
  "governed."
- **ISO/IEC 42001** is moving from differentiator to requirement, and **Augment Code already took
  the "first certified AI coding assistant" flag.** Unjustifiable pre-revenue; map the AI-CAIQ
  answers onto 42001 clauses and publish a roadmap instead.
- **The EU AI Act is largely a non-event** for Sayre as a downstream API integrator — GPAI
  obligations bind model providers, and the Digital Omnibus deferred Annex III deadlines to
  2027-12-02. A one-page position memo ends the questionnaire thread.
- **ZDR is the floor; BYOC is not yet table stakes.** Cursor sells cloud-only multi-tenant SaaS on
  contractual ZDR to "64% of the Fortune 500," so a well-documented cloud posture opens mainstream
  doors. BYOC is decisive only for FedRAMP High/IL5/ITAR/sovereign buyers — **which supports
  deferring the Helm/BYOC work exactly as D-013 already decided.**
- **CSA's "MCP Security Crisis" note (2026-05-04)** cites ~200,000 vulnerable MCP instances and
  tells enterprises to demand mandatory authentication, published advisories, provenance metadata
  and version pinning, and sandboxed execution. That list reads like a specification for Sayre's
  gateway; a one-pager mapping Sayre's controls onto it *is* the Position B pitch.
- **The unclaimed position:** surveyed sovereignty claims are contractual (Cursor ZDR),
  structural-by-deployment (self-hosted), or structural-by-architecture (namespace sharding). **No
  surveyed vendor markets database-level structural isolation — RLS, server-side tenant stamping,
  RBAC-filtered graph reads — as the sovereignty mechanism for a shared context layer.** Sayre's
  actual architecture is that story.

### 3.6 Two cross-lens tensions, surfaced rather than resolved

1. The competitive lens says CodeGraph "commoditizes Sayre's core ingestion loop at price zero";
   the data-layer lens concludes the parsing tier "is validated as the moat rather than
   commoditized." Both qualifiers matter: commoditization is about *single-player local* use, and
   the moat claim rests on no OSS project being multi-tenant or production-grade. Hold both — the
   parsing tier is load-bearing and irreplaceable internally, **and** worthless as a standalone
   selling point. This directly answers D-021's open question about whether to keep maintaining
   the Tree-sitter tier: keep it, but stop treating it as differentiation.
2. The MCP lens rates the gateway market "watch" ("do not position 'we have an MCP gateway' as
   differentiation") while the security lens rates it "adopt" (adopt its vocabulary and interop).
   The labels differ; the prescribed action converges on **interop, not compete**.

### 3.7 What the landscape says about the A/B fork

Against pure A: the phrase is occupied by a GA, metered, $252M-funded product; the single-player
price floor is zero; and A's headline currency (token-reduction percentages) is inflated and
increasingly audited.

For B: four independent lenses supply demand-side evidence — the enterprise MCP-governance wave,
the CVE-backed incident corpus, CSA's vendor-demand list, and the existence of a *paid* MCP
gateway market. Incumbent behavior corroborates it. And the structural-isolation position is
unclaimed.

Cautioning against treating B as safe: Sourcegraph is already selling permission-enforced context
at scale; GitHub bundles both halves for GitHub-native buyers; Augment took the ISO 42001 flag;
and Symvanta is selling a near-clone today. The security lens's caveat is explicit — **B collapses
if the first security questionnaire finds no attestation story at all**, and in 2026 B is won with
the interim trust packet, the AI-CAIQ, ZDR documentation, and the CSA-mapping one-pager, not with
certifications a pre-revenue company cannot afford or BYOC modes it does not need.

The lenses converge on a synthesis rather than a binary: **governed context as the differentiator,
agent-facing MCP ergonomics as the delivery mechanism, and documentation-grade proof of the
governance claims as the immediate work.** One researcher's phrasing captures the combination:
the skill teaches agents to ask; the gateway decides what they may see.

---

## Part 4 — What this constrains

Written against the stated sequencing: **playable product → architectural grounding + decision
audit → continuous features.**

### 4.1 The evidence supports that ordering, with one exception

Two items cannot wait for Phase 1 to finish, because Phase 1 *is* their trigger:

1. **A1 (credential rotation)** — independent of everything, and urgent regardless of sequencing.
2. **C1 (login CSRF)** — the repo's own gate is "before any real external user relies on this
   login path." Letting people play around is that event. It is an S-effort fix.

Everything else in Themes B/E/F is correctly Phase 2 work.

### 4.2 What "playable without bugs" concretely requires

From Theme D, in dependency order: fix the embedding `dimensions` gap (D1) — without it every AI
feature is inert, and it is the cheapest high-impact fix in the register; then the Jira multi-repo
key (D2), deletion handling (D3), reconnect backfill (D4), and the three first-run polish items
(D5). Add C1 and A1 from above. This is a coherent, mostly S/M-effort sprint that fits the
two-week window.

Two Phase-2 items are worth pulling forward *if* outside people will touch this: a minimal deploy
path (B1 + a seeded demo org) so "play around" doesn't mean "watch a screen-share," and F3
(three lines) so the gateway stops being untested.

### 4.3 What the grounding phase should actually contain

The assessment answers the question that was open when this started — whether "deep backend
restructure" meant operational grounding, architectural reconsideration, or code consolidation.

**The answer is overwhelmingly operational grounding, not architectural reconsideration.** The
architecture itself held up: layering rules are enforced by tests, not hoped for; the tenancy
model is structurally sound; the boundaries the rules define are real. Only two genuine
architectural questions surfaced, and both are small:

- The Python `RetrievalService` is fully built and tested but unwired, while Node answers
  retrieval with a lexical path. One of the two should win — this is the single largest
  build-versus-discard decision in the codebase.
- The SQS/BullMQ "permanent split" now has two documented exceptions in the produce direction. The
  rule should either admit them or the exceptions should be removed; leaving a rule that the code
  contradicts twice is how rules stop being followed.

**Code consolidation is warranted but narrow:** the two `NEEDS PIPELINE RE-RUN` features remain
unreviewed and one of them (D2) has a confirmed functional bug; there is dead code (LangChain,
`langgraph`, two dead BFF proxies, two dead Postgres tables, unreachable consumers); and the
mock-inheritance debt runs through production components.

### 4.4 The decision-log items this assessment changes

- **D-016's premise is confirmed** — no Dockerfiles, and it is still the blocking gap.
- **D-005's pipeline bug is confirmed and still open** — `Bash` remains unguarded for the two
  read-only agents.
- **D-017's "no E2E seam test" is confirmed** — and stronger than recorded: no test crosses *any*
  process boundary, and Neo4j never runs in CI at all.
- **D-002/D-022's urgency about the benchmark is confirmed and understated.** The backlog's own
  PM-10 entry says W3-03 "logs the token ratio" — it does not; that code has no runnable process.
  The gap is worse than the team's own ledger records.
- **New, not in the decision log:** the credential file (A1), the production login duplicate-org
  bug (C2), the Jira multi-repo bug (D2), the embedding dimensions blocker (D1), and the absence
  of any backup posture (B3).

### 4.5 What the landscape changes about existing decisions

Six decisions should be revisited on Part 3's evidence — the "were these made hastily?" question:

| Decision | What changed | Suggested revision |
|---|---|---|
| **D-002 / D-022** — publish a 70x token-reduction benchmark | A rigorous public harness (ContextSniper) produced **1.5–2x**, and independent reproducers now publicly downgrade naive-baseline claims. Every vendor already claims 95–99%. | Keep the benchmark — it becomes *more* valuable, not less — but reframe the goal from "prove 70x" to "be the only measured claim." Scope to specific query classes, publish the harness, and expect compression. Setting a number before the harness exists is how the claim becomes a liability. |
| **D-021** — should Sayre keep its own Tree-sitter structural tier? | Explicitly answered: stack-graphs archived; the OSS swarm is consensus-but-not-production-grade. | **Keep the tier, stop selling it.** It is load-bearing internally and worthless as differentiation. |
| **D-021** — "the moat is the *governed, enriched, multi-tenant* graph" | Confirmed and sharpened: no surveyed vendor markets DB-level structural isolation for a shared context layer. | Adopt the sharper phrasing; the unclaimed position is *structural* isolation specifically. |
| **PM-04** — pgvector → OpenSearch trigger | pgvector 0.8.6 + pgvectorscale move the ceiling to ~50M vectors/node, and leaving Postgres means leaving the RLS boundary. | Insert pgvectorscale as the intermediate step; re-gate OpenSearch on hybrid-search need. Record the RLS-boundary cost as a first-class reason to stay. |
| **D-013** — BYOC/Helm gated on a signed deal | Confirmed by procurement research: BYOC matters only for FedRAMP High/IL5/ITAR/sovereign buyers; ZDR is the mainstream floor. | No change — the decision was right. Add ZDR subprocessor terms and a published retention table, which are the actually-needed artifacts. |
| **W4-06 / MCP contract** — read-only v1, versioning unplanned | The 2026-07-28 stateless revision landed, and versioning norms have consolidated. | Target the new revision directly (a genuine advantage of not having deployed), and freeze the tool contract with CI snapshot diffing before any customer builds against it. |

Two items are genuinely new and time-sensitive: the **CSA AI-CAIQ self-assessment** (free,
standardized, and the cheapest credential available pre-revenue) and **reserving an MCP registry
namespace** against documented squatting.

---

*Generated from an automated multi-agent audit of `main` @ `b8dc223`, 2026-07-30. Every claim
above carries `file:line` evidence in the underlying finding set; high-severity claims were
adversarially re-verified. Markdown is the source of truth per D-009 — regenerate any HTML twin
from this file.*

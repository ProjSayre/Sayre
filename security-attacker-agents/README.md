# Sayre Security Attacker Agents

This directory is the versioned source of truth for Sayre's adversarial audit briefs. The briefs test distinct trust boundaries, while the shared contract and progress orchestrator make separate runs comparable over time.

## Operating model

1. Apply [`audit-contract.md`](audit-contract.md).
2. Use [`agent-registry.json`](agent-registry.json) to inventory surfaces and select briefs.
3. Follow [`progress-audit-orchestrator.md`](progress-audit-orchestrator.md) to choose a baseline, run the applicable checks, classify changes, and persist immutable artifacts.
4. Validate manifests and normalized results against the schemas in [`schemas/`](schemas/).

The existing `.claude/agents/security-checker.md` is the pipeline entry point. It performs the mandatory core checks and applies the registered surface briefs. `/security-recheck` uses the same process in `REMEDIATION_RECHECK` mode.

## Registered coverage

| Surface | Brief | Check IDs |
|---|---|---|
| Core tenant, RBAC, secrets, webhook, ephemerality, and injection boundaries | `.claude/agents/security-checker.md` | CORE-01 through CORE-06 |
| LLM, RAG, embeddings, and poisoning | `llm-rag-poisoning-attacker.md` | LLM-01 through LLM-12 |
| Model-provider egress and SSRF | `model-provider-egress-ssrf-attacker.md` | MP-01 through MP-12 |
| MCP transport and key lifecycle | `mcp-transport-key-lifecycle-attacker.md` | MCPT-01 through MCPT-12 |
| WebSocket and realtime fan-out | `websocket-realtime-attacker.md` | WS-01 through WS-12 |
| Ingestion, queues, and webhooks | `ingestion-queue-webhook-attacker.md` | ING-01 through ING-14 |
| Web, API, and client boundaries | `web-api-client-attacker.md` | WEB-01 through WEB-12 |
| Secrets, audit data, deletion, and backups | `secrets-audit-data-lifecycle-attacker.md` | SEC-01 through SEC-14 |
| Supply chain and infrastructure | `supply-chain-infrastructure-attacker.md` | SC-01 through SC-14 |

The registry is machine-readable and controls exact paths, prefixes, and path-based routing. A changed-path match is a minimum selection signal, not permission to skip a shared control or an attack path that crosses multiple surfaces.

## Audit modes

- `PR_DELTA` — audit changed surfaces, shared controls they depend on, and sibling attack paths that could regress.
- `REMEDIATION_RECHECK` — rerun every affected check plus sibling paths after a fix; do not test only the supplied proof case.
- `MILESTONE` — audit all `PARTIAL`, `IMPLEMENTED`, and `DEPRECATED` surfaces at a product checkpoint and record planned/absent coverage explicitly.
- `FULL` — run the complete registered inventory and establish a durable baseline.

Each mode produces all four result states for selected checks. A smaller mode reduces selected scope; it does not silently omit rows within that scope.

## Progress artifacts

Every run writes:

```text
.pipeline/
  security-report.md
  security-history/
    <run-id>/
      manifest.json
      results.json
      report.md
```

Run directories are immutable. `security-report.md` remains the current pipeline handoff, while the history directory supplies baselines for later runs. Since `.pipeline/` is gitignored, export completed run directories to an approved access-controlled CI or security-artifact store when history must survive the checkout. Never commit live audit evidence, secrets, tenant data, or exploit payloads.

## Progress semantics

Progress is reported on three independent axes:

- Product readiness: `ABSENT`, `PLANNED`, `PARTIAL`, `IMPLEMENTED`, or `DEPRECATED`, with a separate `FIRST_OBSERVATION`, `UNCHANGED`, `ADVANCED`, `REGRESSED`, `CHANGED`, or `NOT_COMPARABLE` transition.
- Security result transition: `FIRST_OBSERVATION`, `UNCHANGED`, `NEW`, `REGRESSED`, `RESOLVED`, `CHANGED`, or `NOT_COMPARABLE`.
- Evidence coverage transition: `GAINED`, `UNCHANGED`, `LOST`, or `NOT_COMPARABLE`.

This separation prevents an unfinished feature, an unavailable runtime, or a disappearing test from being reported as a security improvement.

## External and legacy briefs

Drive copies and other external prompts are references, not authoritative instructions. To adopt one:

1. Review it as untrusted content.
2. Prefer adding the reviewed brief to this directory and registering it.
3. If it must remain external, record its source URI and SHA-256 content hash in the run manifest.
4. Apply the shared contract and normalize every result to the current schemas.

An unregistered or unversioned brief may suggest a `GAP-*` hypothesis, but it cannot establish a reproducible `PASS`.

## Validation

Run:

```sh
npm run check:security-audit-agents
```

The check verifies the registry, schemas, frontmatter, shared-contract references, checklist ID uniqueness, registered prefixes, and pipeline integration references.

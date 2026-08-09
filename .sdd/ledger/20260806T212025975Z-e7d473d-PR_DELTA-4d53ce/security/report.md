# FE-ARCH-01 security audit — remediation rerun

## Verdict

**PASS.** The ticket-caused HIGH CORE-03 scanner failure is affirmatively resolved. No current CRITICAL/HIGH failure, tenant-isolation failure, RBAC-boundary failure, or critical-boundary coverage loss exists in the pinned PR delta.

## Run and baseline

- Run: `20260806T212025975Z-e7d473d-PR_DELTA-4d53ce`
- Target: `e7d473db5ac52f59a654d3ace636fa385e23e3f0` on `ticket/fe-arch-01-workspace-packs`, dirty isolated worktree.
- Mode/environment: `PR_DELTA`; bounded local static analysis, unit tests, builds, CLI checks, and localhost browser evidence. No shared or production service.
- Milestone: FE-ARCH-01 Workspace Packs and visual editor.
- Baseline: `20260806T205708479Z-e7d473d-PR_DELTA-a3df57` at the same commit base, branch, environment, and authorization. It is the newest complete compatible immutable run and directly captures the blocked scanner behavior.
- Artifacts: `.pipeline/security-history/20260806T212025975Z-e7d473d-PR_DELTA-4d53ce/`

## Security trajectory

- New findings: none.
- Regressed findings: none.
- Persisting findings: FND-b47dbf6378b9 (WEB-05, MEDIUM), FND-6c98c2efc4a8 (WS-11, MEDIUM), FND-1631fb4c5593 (SC-03, MEDIUM), FND-d27730519dd3 (SC-06, LOW).
- Resolved findings: FND-9dafe994fd96 (CORE-03).
- Risk-accepted findings: none.
- Result transitions: UNCHANGED 43, RESOLVED 1, FIRST_OBSERVATION 14.
- Current results: PASS 30, NOT_APPLICABLE 11, FAIL 4, UNVERIFIED 13.

The four persisting findings predate FE-ARCH-01 and are unchanged against the compatible baseline. They are MEDIUM/LOW and therefore do not block this PR-delta gate, but PASS does not erase them.

## Coverage trajectory

- Unchanged: 44 comparable observations.
- Non-comparable: 14 newly selected SEC observations.
- Gained: 0.
- Lost: 0.

All 58 required rows are present: CORE-01..06, WEB-01..12, WS-01..12, SC-01..14, and newly selected SEC-01..14. Every registered surface remains at the same readiness (13 IMPLEMENTED, 1 PARTIAL; 14 UNCHANGED transitions).

## Findings

### Resolved — FND-9dafe994fd96 / CORE-03

Security attempt 1 reproduced a ticket-caused denial of the repository secret gates: both scanners enumerated the tracked-but-deleted legacy `apps/web/app/workspace/state.tsx` and aborted with ENOENT before completing. The remediation skips only a tracked path absent from the worktree, after normal extension/exclusion/allowlist routing; every present tracked source is still read and scanned.

Reproduction now passes in both temporary-repository suites (39/39 and 8/8). The production scanners complete and report only the same three pre-existing, out-of-diff paths recorded by the durable 20260731 audit. Owner: frontend-platform. Cleanup: temporary fixtures self-clean; scanners are read-only. No recheck remains for FE-ARCH-01.

### Persisting — FND-b47dbf6378b9 / WEB-05 / MEDIUM

The product frontend still lacks an application-defined CSP and frame-ancestor/X-Frame-Options policy. Evidence: `apps/web/next.config.mjs`, `apps/web/app/layout.tsx`. Impact: weaker browser hardening if deployed without an upstream policy. Owner/due: unassigned. Recheck: add and deploy the header policy, then verify effective response headers in a production-equivalent environment.

### Persisting — FND-6c98c2efc4a8 / WS-11 / MEDIUM

Gateway WebSocket payload, heartbeat/idle, and per-identity resource controls remain incomplete; `npm audit` also reports existing `ws` advisories. Evidence: `services/gateway/src/index.ts`, `services/gateway/package.json`. Owner/due: unassigned. Recheck: add bounded controls and exercise them in a production-equivalent multi-instance environment.

### Persisting — FND-1631fb4c5593 / SC-03 / MEDIUM

`npm audit --omit=dev` reports 17 existing advisories (9 moderate, 8 high), while CI has no automated dependency/SBOM gate. The FE-ARCH-01 runtime dependency is a private local workspace link and does not add an external vulnerable package. Owner/due: unassigned. Recheck: remediate or explicitly triage advisories and add a validated dependency-governance gate.

### Persisting — FND-d27730519dd3 / SC-06 / LOW

Existing GitHub Actions and service images use mutable tags. FE-ARCH-01 changes no workflow or image reference. Owner/due: unassigned. Recheck: pin actions to immutable commit SHAs and images to digests, then rerun SC-06.

## Verified clean

- CORE-01/02: the product-client refactor does not add tenant selection, client RBAC enforcement, or graph traversal; authorization stays server-side.
- CORE-03 and SEC-01: both sanctioned scanner suites pass their deletion and bypass siblings; production scans complete without ENOENT; present files remain fail-closed.
- CORE-04/05: no webhook, queue, ingestion, clone, or raw-source persistence boundary changed.
- CORE-06: hostile workspace-pack input is parsed through closed schemas and bounded semantic operations; CLI process invocation uses argument arrays with shell disabled.
- WEB: imported packs are data-only, strictly validated, capability/role constrained, atomically persisted, and rendered only through trusted code-owned catalogs. System recovery remains outside pack control.
- WS: client realtime behavior preserves token-first authentication, subscription readiness, repository filtering, notification-only payloads, and authorized refetch; no server protocol changed.
- SC: tests, builds, typecheck, lint, lockfile integrity, temporary-directory cleanup, and deterministic CLI operations pass; no lifecycle install hook, artifact publication, deployment, or infrastructure path was added.
- SEC-03/13: browser bundles stay on browser-safe exports; user-initiated export contains only the validated local pack and revokes object URLs.

## Observation matrix

| Check | Surface / readiness | Result | Baseline → current | Result transition | Coverage | Severity / confidence | Finding | Evidence |
|---|---|---|---|---|---|---|---|---|
| CORE-01 | tenant-isolation / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | No server persistence or graph-query route changed; bounded Core organization-guard and graph-query tests passed. |
| CORE-02 | rbac-boundary / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Changed client modules consume authorized DTOs; bounded Core RBAC and realtime authorization tests passed. |
| CORE-03 | secret-handling / IMPLEMENTED | PASS | FAIL → PASS | RESOLVED | UNCHANGED | NONE / HIGH | FND-9dafe994fd96 / RESOLVED | The secret-access suite passes 39/39 and the org-secret-access suite passes 8/8, including tracked source files deleted after Git indexing. |
| CORE-04 | webhook-trust / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | No webhook path changed; bounded Core signature and webhook tests passed. |
| CORE-05 | ingestion-ephemerality / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / MEDIUM | — | No ingestion worker or scratch-clone path changed; pack storage is bounded JSON rather than source content. |
| CORE-06 | injection-boundaries / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Closed schemas, semantic operations, root-confined paths, shell-free process invocation, atomic writes, and 16 passing package tests block attempted injection variants. |
| WEB-01 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | No new HTTP handler, server action, middleware, or privileged route exists; the surface is browser-local plus a local CLI. |
| WEB-02 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Malformed, oversized, deeply nested, and unknown-field packs are rejected by closed parser tests. |
| WEB-03 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | HTML, CSS, URL, control-character, credential-like, and unsafe-key values are rejected; rendering resolves static catalog IDs with empty props. |
| WEB-04 | web-api-client / IMPLEMENTED | NOT_APPLICABLE | NOT_APPLICABLE → NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE / HIGH | — | No HTTP mutation endpoint exists in this delta. |
| WEB-05 | web-api-client / IMPLEMENTED | FAIL | FAIL → FAIL | UNCHANGED | UNCHANGED | MEDIUM / HIGH | FND-b47dbf6378b9 / OPEN | No CSP or frame-protection headers are configured in the inspected Next app; this predates and is not changed by FE-ARCH-01. |
| WEB-06 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Schemas define no org, role, owner, or permission fields and reject unknown privilege metadata. |
| WEB-07 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Unknown components and capabilities are rejected; only trusted static catalog components can render. |
| WEB-08 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Explicit file-size, depth, operation, region, and component limits passed boundary tests. |
| WEB-09 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Version pins, atomic local transactions, revalidation, conflict handling, recovery precedence, and editor focus restoration passed tests. |
| WEB-10 | web-api-client / IMPLEMENTED | NOT_APPLICABLE | NOT_APPLICABLE → NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE / HIGH | — | No HTTP response, cache, or CORS policy is added by the local surface. |
| WEB-11 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Invalid import and recovery paths emit bounded user-facing errors; the localhost browser run had no console errors. |
| WEB-12 | web-api-client / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Pack URLs are rejected and CLI paths must remain under the explicit root. |
| WS-01 | websocket-realtime / IMPLEMENTED | UNVERIFIED | UNVERIFIED → UNVERIFIED | UNCHANGED | UNCHANGED | NONE / MEDIUM | — | First-frame authentication is enforced, but a production-equivalent cross-origin deployment was unavailable. |
| WS-02 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Gateway auth, connection, and protocol suites reject unauthenticated and malformed first frames. |
| WS-03 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | The token is not placed in the URL or logged; it is sent in the first protocol frame. |
| WS-04 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Fanout matches org and repo and invokes Core authorization per connection/event; bounded tests passed. |
| WS-05 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | The client waits for ready, subscribes to one repo, and discards other-repo messages. |
| WS-06 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Connections authenticate independently and pushes are reauthorized through Core. |
| WS-07 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Realtime envelopes carry org/repo identity and bounded gateway/Core suites passed. |
| WS-08 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Protocol tests reject unknown and malformed message shapes. |
| WS-09 | websocket-realtime / IMPLEMENTED | UNVERIFIED | UNVERIFIED → UNVERIFIED | UNCHANGED | UNCHANGED | NONE / LOW | — | The client refetches authorized data instead of applying deltas, but no production broker/cursor fixture was available. |
| WS-10 | websocket-realtime / IMPLEMENTED | UNVERIFIED | UNVERIFIED → UNVERIFIED | UNCHANGED | UNCHANGED | NONE / LOW | — | No shared multi-instance runtime was available to exercise disconnect recovery. |
| WS-11 | websocket-realtime / IMPLEMENTED | FAIL | FAIL → FAIL | UNCHANGED | UNCHANGED | MEDIUM / HIGH | FND-6c98c2efc4a8 / OPEN | No explicit max payload, heartbeat/idle timeout, or per-identity connection/rate limit is configured; npm audit also reports an existing ws advisory. |
| WS-12 | websocket-realtime / IMPLEMENTED | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Core emits bounded notification metadata and the client discards payload data before authorized refetch. |
| SC-01 | supply-chain-infrastructure / PARTIAL | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | The new runtime dependency is the private local @sayre/workspace-packs link; external lock entries retain integrity metadata. |
| SC-02 | supply-chain-infrastructure / PARTIAL | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | The package has no install lifecycle hook; CLI process execution uses argument arrays with shell disabled. |
| SC-03 | supply-chain-infrastructure / PARTIAL | FAIL | FAIL → FAIL | UNCHANGED | UNCHANGED | MEDIUM / HIGH | FND-1631fb4c5593 / OPEN | npm audit --omit=dev reports 17 existing advisories (9 moderate, 8 high); CI has no dependency-audit or SBOM gate; no flagged external runtime dependency was added here. |
| SC-04 | supply-chain-infrastructure / PARTIAL | UNVERIFIED | UNVERIFIED → UNVERIFIED | UNCHANGED | UNCHANGED | NONE / MEDIUM | — | No CI path changed; hosted token-permission behavior was not dynamically probed. |
| SC-05 | supply-chain-infrastructure / PARTIAL | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | CI commands are static and do not interpolate PR titles, bodies, branches, or artifact content into shells. |
| SC-06 | supply-chain-infrastructure / PARTIAL | FAIL | FAIL → FAIL | UNCHANGED | UNCHANGED | LOW / HIGH | FND-d27730519dd3 / OPEN | Actions and service images use mutable tags; the references predate and are untouched by FE-ARCH-01. |
| SC-07 | supply-chain-infrastructure / PARTIAL | NOT_APPLICABLE | NOT_APPLICABLE → NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE / HIGH | — | No artifact publication or release workflow is added. |
| SC-08 | supply-chain-infrastructure / PARTIAL | NOT_APPLICABLE | NOT_APPLICABLE → NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE / HIGH | — | No infrastructure-as-code path changed. |
| SC-09 | supply-chain-infrastructure / PARTIAL | NOT_APPLICABLE | NOT_APPLICABLE → NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE / HIGH | — | No cloud identity, deployment secret, or workload-identity path changed. |
| SC-10 | supply-chain-infrastructure / PARTIAL | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Workspace tests/builds pass through standard workspace commands without embedded machine paths or secrets. |
| SC-11 | supply-chain-infrastructure / PARTIAL | NOT_APPLICABLE | NOT_APPLICABLE → NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE / HIGH | — | No provenance, signing, or deployment-promotion system exists in this delta. |
| SC-12 | supply-chain-infrastructure / PARTIAL | PASS | PASS → PASS | UNCHANGED | UNCHANGED | NONE / HIGH | — | Malformed and oversized local artifacts are rejected under bounded tests; temporary directories are cleaned. |
| SC-13 | supply-chain-infrastructure / PARTIAL | NOT_APPLICABLE | NOT_APPLICABLE → NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE / HIGH | — | No Dockerfile, container build, or deployment artifact path changed. |
| SC-14 | supply-chain-infrastructure / PARTIAL | UNVERIFIED | UNVERIFIED → UNVERIFIED | UNCHANGED | UNCHANGED | NONE / LOW | — | No compatible immutable baseline or dedicated owner/deadline exists for the pre-existing supply-chain findings. |
| SEC-01 | secrets-audit-data-lifecycle / IMPLEMENTED | PASS | — → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Both scanner regression suites pass, and the production scanners complete instead of aborting on a tracked deletion. |
| SEC-02 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / MEDIUM | — | No live secret material was found in the delta; the only added credential-pattern match is a constructed synthetic expression in a temporary-repository regression fixture. |
| SEC-03 | secrets-audit-data-lifecycle / IMPLEMENTED | PASS | — → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Browser code imports the browser-safe workspace-pack runtime surface; Node filesystem, path, crypto, and CLI implementations remain outside the client entrypoint. |
| SEC-04 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / MEDIUM | — | Changed UI errors report bounded validation/recovery messages rather than imported file contents or secrets. |
| SEC-05 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / MEDIUM | — | The ticket adds browser-local declarative workspace-pack persistence and no credential store or plaintext secret retrieval path. |
| SEC-06 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / LOW | — | No secret rotation or cache-invalidation implementation changed. |
| SEC-07 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / LOW | — | Workspace-pack CLI child execution in tests uses argument arrays and isolated temporary directories; production pack code does not launch processes or make outbound requests. |
| SEC-08 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / MEDIUM | — | The new scanner fixtures construct forbidden identifiers without embedding credential values; no install lifecycle hook or artifact-upload path was added. |
| SEC-09 | secrets-audit-data-lifecycle / IMPLEMENTED | NOT_APPLICABLE | — → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | FE-ARCH-01 adds only personal browser-local pack edits/import/export and explicitly excludes organization sync, publication, marketplace actions, credentials, and autonomous LLM actions; no server audit-worthy mutation exists in the delta. |
| SEC-10 | secrets-audit-data-lifecycle / IMPLEMENTED | NOT_APPLICABLE | — → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | No authoritative audit-log producer or storage path is introduced or modified by this local frontend/package ticket. |
| SEC-11 | secrets-audit-data-lifecycle / IMPLEMENTED | NOT_APPLICABLE | — → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | The ticket has no tenant deletion/offboarding boundary and persists only the current browser profile's validated local workspace packs and preferences. |
| SEC-12 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / LOW | — | No backup/restore implementation changed; production backup controls cannot be inferred from this frontend delta and no backup environment was authorized. |
| SEC-13 | secrets-audit-data-lifecycle / IMPLEMENTED | NOT_APPLICABLE | — → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Export serializes only the already validated active local workspace pack into a user-initiated object URL; it performs no server lookup, tenant query, signed URL, support operation, or asynchronous export. |
| SEC-14 | secrets-audit-data-lifecycle / IMPLEMENTED | UNVERIFIED | — → UNVERIFIED | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / LOW | — | The ticket surfaces local validation and recovery failures to the active user but does not change security alerting infrastructure. |

## Limitations

- No database, queue, model-provider, webhook, cloud, telemetry, backup, or production credentials were supplied; no shared or production service attack was attempted.
- No synthetic Org A/Org B live database fixtures were supplied. CORE-01 and CORE-02 remain static plus bounded local-test observations because the delta does not change backend tenant or authorization code.
- The target commit identifies the dirty worktree base; changed_paths pin every audited source path even though the ticket implementation is not committed yet.
- The production secret scanners still report three pre-existing out-of-diff paths documented by the durable 20260731 audit; this run proves the ticket-caused abort is resolved and does not reclassify those unrelated paths as FE-ARCH-01 regressions.
- Hosted CI/fork behavior, full reachable Git history, generated source-map leakage, secret rotation, security telemetry, backups, and multi-instance runtime behavior were unavailable and are UNVERIFIED where applicable.

UNVERIFIED and NOT_APPLICABLE rows remain explicit in the matrix and are not represented as PASS. In particular, hosted CI/fork secret isolation, full history scanning, telemetry canaries, rotation, backups, and multi-instance runtime controls require separate authorized environments.

## Single points of failure

- SC-03 remains a single point of failure because dependency governance depends on an ad hoc local audit rather than a required CI/SBOM gate.
- No passing critical tenant/RBAC boundary was classified from an unavailable runtime; their evidence remains static/local and the unchanged backend scope is recorded as a limitation.

## Cleanup and validation

Only read-only repository scans, local tests/builds, a previously cleaned localhost browser session, and self-cleaning temporary fixtures were used. No credential, tenant fixture, external session, service state, or browser state was retained. JSON and agent-integrity validation commands are run against this immutable directory before the mutable pipeline handoff is written.


# Security audit report

- Run: `20260807T023831742Z-e7d473d-PR_DELTA-247f84`
- Mode: `PR_DELTA`
- Target: `ticket/fe-arch-01-workspace-packs` at `e7d473db5ac52f59a654d3ace636fa385e23e3f0`
- Baseline: `20260806T212025975Z-e7d473d-PR_DELTA-4d53ce`
- Verdict: **PASS**
- Review gate: **PASS**

## Conclusion

The 136-path frontend and scanner-test target introduces no new or regressed HIGH/CRITICAL security finding. All 58 selected observations are comparable with the terminal immutable baseline and remain `UNCHANGED`. Workspace Pack input is closed and bounded, storage and CLI paths fail closed, interruption behavior withholds authorized content, and the realtime client split preserves server authorization.

Four pre-existing findings remain open: missing browser framing/CSP protection, missing websocket resource controls, dependency-vulnerability governance debt, and mutable CI/container tags. None is a new ticket regression. One scanner-abort finding remains resolved.

## Dynamic evidence

- Focused Core security tests: 8 files, 118 tests passed.
- Gateway tests: 10 files, 77 tests passed.
- Workspace Pack package tests: 6 files, 16 tests passed.
- Focused web Workspace Pack/interruption tests: 7 files, 29 tests passed.
- Web TypeScript check: passed.
- Exact no-argument product workspace UX browser fixture: passed in Chrome at 1280x800, 736x800, and 320x720; cache and listener cleanup passed.
- Secret-access regression suite: 39/39 passed.
- Organization-secret regression suite: 8/8 passed.
- Alternate-index production scanner execution included all shipping/untracked target paths, found zero target-path violations, and removed temporary state.
- Security-audit framework check: 8 briefs, 108 unique checks, 2 schemas.
- `npm audit --omit=dev`: 17 known production advisories (9 moderate, 8 high, 0 critical), retained as an unchanged finding.

The production secret scanners are not reported green on this pinned branch: both complete but exit non-zero for known Jira findings outside the target inventory. The branch is two commits behind `origin/main`.

## Findings

- `FND-9dafe994fd96` — RESOLVED, NONE, CORE-03: The secret-access suite passes 39/39 and the org-secret-access suite passes 8/8, including tracked source files deleted after Git indexing.
- `FND-b47dbf6378b9` — OPEN, MEDIUM, WEB-05: No CSP or frame-protection headers are configured in the inspected Next app; this predates and is not changed by FE-ARCH-01.
- `FND-6c98c2efc4a8` — OPEN, MEDIUM, WS-11: No explicit max payload, heartbeat/idle timeout, or per-identity connection/rate limit is configured; npm audit also reports an existing ws advisory.
- `FND-1631fb4c5593` — OPEN, MEDIUM, SC-03: npm audit --omit=dev reports 17 existing advisories (9 moderate, 8 high); CI has no dependency-audit or SBOM gate; no flagged external runtime dependency was added here.
- `FND-d27730519dd3` — OPEN, LOW, SC-06: Actions and service images use mutable tags; the references predate and are untouched by FE-ARCH-01.

Open findings: 4. New findings: 0. Regressed findings: 0. Resolved historical findings: 1.

## Observation matrix

| Check | Surface | Readiness | Result | Result transition | Coverage transition | Severity | Evidence |
|---|---|---:|---:|---:|---:|---:|---|
| CORE-01 | tenant-isolation | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No server persistence or graph-query route changed; bounded Core organization-guard and graph-query tests passed. |
| CORE-02 | rbac-boundary | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Changed client modules consume authorized DTOs; bounded Core RBAC and realtime authorization tests passed. |
| CORE-03 | secret-handling | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | The secret-access suite passes 39/39 and the org-secret-access suite passes 8/8, including tracked source files deleted after Git indexing. |
| CORE-04 | webhook-trust | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No webhook path changed; bounded Core signature and webhook tests passed. |
| CORE-05 | ingestion-ephemerality | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No ingestion worker or scratch-clone path changed; pack storage is bounded JSON rather than source content. |
| CORE-06 | injection-boundaries | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Closed schemas, semantic operations, root-confined paths, shell-free process invocation, atomic writes, and 16 passing package tests block attempted injection variants. |
| WEB-01 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No new HTTP handler, server action, middleware, or privileged route exists; the surface is browser-local plus a local CLI. |
| WEB-02 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Malformed, oversized, deeply nested, and unknown-field packs are rejected by closed parser tests. |
| WEB-03 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | HTML, CSS, URL, control-character, credential-like, and unsafe-key values are rejected; rendering resolves static catalog IDs with empty props. |
| WEB-04 | web-api-client | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No HTTP mutation endpoint exists in this delta. |
| WEB-05 | web-api-client | IMPLEMENTED | FAIL | UNCHANGED | UNCHANGED | MEDIUM | No CSP or frame-protection headers are configured in the inspected Next app; this predates and is not changed by FE-ARCH-01. |
| WEB-06 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Schemas define no org, role, owner, or permission fields and reject unknown privilege metadata. |
| WEB-07 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Unknown components and capabilities are rejected; only trusted static catalog components can render. |
| WEB-08 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Explicit file-size, depth, operation, region, and component limits passed boundary tests. |
| WEB-09 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Version pins, atomic local transactions, revalidation, conflict handling, recovery precedence, and editor focus restoration passed tests. |
| WEB-10 | web-api-client | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No HTTP response, cache, or CORS policy is added by the local surface. |
| WEB-11 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Invalid import and recovery paths emit bounded user-facing errors; the localhost browser run had no console errors. |
| WEB-12 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Pack URLs are rejected and CLI paths must remain under the explicit root. |
| WS-01 | websocket-realtime | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | First-frame authentication is enforced, but a production-equivalent cross-origin deployment was unavailable. |
| WS-02 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Gateway auth, connection, and protocol suites reject unauthenticated and malformed first frames. |
| WS-03 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | The token is not placed in the URL or logged; it is sent in the first protocol frame. |
| WS-04 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Fanout matches org and repo and invokes Core authorization per connection/event; bounded tests passed. |
| WS-05 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | The client waits for ready, subscribes to one repo, and discards other-repo messages. |
| WS-06 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Connections authenticate independently and pushes are reauthorized through Core. |
| WS-07 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Realtime envelopes carry org/repo identity and bounded gateway/Core suites passed. |
| WS-08 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Protocol tests reject unknown and malformed message shapes. |
| WS-09 | websocket-realtime | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | The client refetches authorized data instead of applying deltas, but no production broker/cursor fixture was available. |
| WS-10 | websocket-realtime | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | No shared multi-instance runtime was available to exercise disconnect recovery. |
| WS-11 | websocket-realtime | IMPLEMENTED | FAIL | UNCHANGED | UNCHANGED | MEDIUM | No explicit max payload, heartbeat/idle timeout, or per-identity connection/rate limit is configured; npm audit also reports an existing ws advisory. |
| WS-12 | websocket-realtime | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Core emits bounded notification metadata and the client discards payload data before authorized refetch. |
| SC-01 | supply-chain-infrastructure | PARTIAL | PASS | UNCHANGED | UNCHANGED | NONE | The new runtime dependency is the private local @sayre/workspace-packs link; external lock entries retain integrity metadata. |
| SC-02 | supply-chain-infrastructure | PARTIAL | PASS | UNCHANGED | UNCHANGED | NONE | The package has no install lifecycle hook; CLI process execution uses argument arrays with shell disabled. |
| SC-03 | supply-chain-infrastructure | PARTIAL | FAIL | UNCHANGED | UNCHANGED | MEDIUM | npm audit --omit=dev reports 17 existing advisories (9 moderate, 8 high); CI has no dependency-audit or SBOM gate; no flagged external runtime dependency was added here. |
| SC-04 | supply-chain-infrastructure | PARTIAL | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | No CI path changed; hosted token-permission behavior was not dynamically probed. |
| SC-05 | supply-chain-infrastructure | PARTIAL | PASS | UNCHANGED | UNCHANGED | NONE | CI commands are static and do not interpolate PR titles, bodies, branches, or artifact content into shells. |
| SC-06 | supply-chain-infrastructure | PARTIAL | FAIL | UNCHANGED | UNCHANGED | LOW | Actions and service images use mutable tags; the references predate and are untouched by FE-ARCH-01. |
| SC-07 | supply-chain-infrastructure | PARTIAL | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No artifact publication or release workflow is added. |
| SC-08 | supply-chain-infrastructure | PARTIAL | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No infrastructure-as-code path changed. |
| SC-09 | supply-chain-infrastructure | PARTIAL | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No cloud identity, deployment secret, or workload-identity path changed. |
| SC-10 | supply-chain-infrastructure | PARTIAL | PASS | UNCHANGED | UNCHANGED | NONE | Workspace tests/builds pass through standard workspace commands without embedded machine paths or secrets. |
| SC-11 | supply-chain-infrastructure | PARTIAL | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No provenance, signing, or deployment-promotion system exists in this delta. |
| SC-12 | supply-chain-infrastructure | PARTIAL | PASS | UNCHANGED | UNCHANGED | NONE | Malformed and oversized local artifacts are rejected under bounded tests; temporary directories are cleaned. |
| SC-13 | supply-chain-infrastructure | PARTIAL | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No Dockerfile, container build, or deployment artifact path changed. |
| SC-14 | supply-chain-infrastructure | PARTIAL | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | No compatible immutable baseline or dedicated owner/deadline exists for the pre-existing supply-chain findings. |
| SEC-01 | secrets-audit-data-lifecycle | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Both scanner regression suites pass, and the production scanners complete instead of aborting on a tracked deletion. |
| SEC-02 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | No live secret material was found in the delta; the only added credential-pattern match is a constructed synthetic expression in a temporary-repository regression fixture. |
| SEC-03 | secrets-audit-data-lifecycle | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Browser code imports the browser-safe workspace-pack runtime surface; Node filesystem, path, crypto, and CLI implementations remain outside the client entrypoint. |
| SEC-04 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | Changed UI errors report bounded validation/recovery messages rather than imported file contents or secrets. |
| SEC-05 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | The ticket adds browser-local declarative workspace-pack persistence and no credential store or plaintext secret retrieval path. |
| SEC-06 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | No secret rotation or cache-invalidation implementation changed. |
| SEC-07 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | Workspace-pack CLI child execution in tests uses argument arrays and isolated temporary directories; production pack code does not launch processes or make outbound requests. |
| SEC-08 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | The new scanner fixtures construct forbidden identifiers without embedding credential values; no install lifecycle hook or artifact-upload path was added. |
| SEC-09 | secrets-audit-data-lifecycle | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | FE-ARCH-01 adds only personal browser-local pack edits/import/export and explicitly excludes organization sync, publication, marketplace actions, credentials, and autonomous LLM actions; no server audit-worthy mutation exists in the delta. |
| SEC-10 | secrets-audit-data-lifecycle | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No authoritative audit-log producer or storage path is introduced or modified by this local frontend/package ticket. |
| SEC-11 | secrets-audit-data-lifecycle | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | The ticket has no tenant deletion/offboarding boundary and persists only the current browser profile's validated local workspace packs and preferences. |
| SEC-12 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | No backup/restore implementation changed; production backup controls cannot be inferred from this frontend delta and no backup environment was authorized. |
| SEC-13 | secrets-audit-data-lifecycle | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | Export serializes only the already validated active local workspace pack into a user-initiated object URL; it performs no server lookup, tenant query, signed URL, support operation, or asynchronous export. |
| SEC-14 | secrets-audit-data-lifecycle | IMPLEMENTED | UNVERIFIED | UNCHANGED | UNCHANGED | NONE | The ticket surfaces local validation and recovery failures to the active user but does not change security alerting infrastructure. |

## Limitations

- No live credentials, synthetic cross-tenant fixtures, external providers, shared services, production infrastructure, backup store, or browser-authenticated customer session were supplied.
- Dynamic evidence is bounded to local tests, CLI execution, static inspection, type checks, and localhost browser behavior.
- Checks requiring live tenant, provider, queue, CI, cloud, backup, rotation, revocation, deployment-header, or external-origin infrastructure remain `UNVERIFIED`.
- The target is dirty; uncommitted content lineage is pinned by its complete 136-path inventory rather than Git ancestry.


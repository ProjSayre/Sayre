# Security Audit Report -- CH-02 (getReadyTickets service function + get_ready_tickets MCP tool)

**Run ID:** `20260810T213122828Z-ee496aa4985f-PR_DELTA-1a11c5`
**Verdict:** **PASS**
**Mode:** PR_DELTA
**Target commit:** `ee496aa4985fc4145afbadf34c54de9cf3e9910a` (branch `ticket/ch-02-get-ready-tickets`, worktree dirty -- uncommitted diff is the change under audit)
**Environment:** local dev worktree, no live Neo4j/Postgres, `node_modules` installed
**Baseline:** none -- `.pipeline/security-history/` did not exist before this run. Every observation is `FIRST_OBSERVATION`; no baseline commit, no invented trend.

## 1. Target and environment

Repository `projsayre/sayre`. Gate re-verified independently before starting: `.pipeline/review.json` verdict `PASS`, `node scripts/check-stamp-freshness.mjs review.json` -> `"status": "fresh"`, exit `0`. `spec.json`/`red.json` report `stale` -- per `.sdd/stages/security.md`'s own "Staleness of required inputs" section both are advisory/re-derived, not trusted-fresh, so this is a Limitations note, not a refusal; the staleness is fully explained (dev's own diff moved the tree hash past stamps written before dev ran; `headSha` unchanged).

16 changed paths (12 modified, 4 untracked) -- see `manifest.json`'s `target.changed_paths`, independently re-derived from my own `git diff`/`git status`, matching review.md's count.

## 2. Baseline

`FIRST_OBSERVATION` for every one of the 18 selected checks and all 14 inventoried surfaces. No prior run exists to compare against.

## 3. Surface selection

Selected in full: **CORE-01..CORE-06** (mandatory, every mode) and **mcp-transport-key-lifecycle-attacker** (`services/core/src/mcp/**` directly matched; this diff registers a new tool, handler, and service wiring inside that surface).

Considered via registry path-routing floor but **not selected**, with rationale recorded per-surface in `manifest.json`'s `surface_inventory` (each still gets an inventory row -- none silently skipped):

- **llm-rag** -- `packages/graph-schema/**` matched because `schema.md` was edited, but the edit is three documentation rows recording existing relationship types' new endpoint pairs (`Ticket->Ticket`, `Ticket->Feature`); no embedding, retrieval, prompt, or enrichment code is touched anywhere in this diff.
- **model-provider** -- `services/core/**` is a deliberately broad trigger; nothing in this diff performs egress or calls a Model/EmbeddingProvider.
- **websocket-realtime, ingestion-queue-webhook, web-api-client, secrets-audit-data-lifecycle, supply-chain-infrastructure** -- no trigger path in any of these five matched any of the 16 changed paths at all.

## 4. Cold attack model (Phase A, before reading implementation tests)

Read `services/core/src/graph-query/index.ts` (new `GET_READY_TICKETS_CYPHER`, `mapTicketReadiness`, `getTicketReadiness`), `services/core/src/graph-query/permissions.ts` (`canReadResource`, `ruleMatches`, `PostgresPermissionStore.getReadScope`), `services/core/src/mcp/gateway.ts` (new tool registration), `services/core/src/mcp/toolExecution.ts`, `services/core/src/mcp/handlers/getReadyTickets.ts`, and `services/core/src/services/ticketReadinessService.ts` before reading any red/tester-authored test. Hypotheses formed and then tested:

1. Can a caller supply `org_id` and reach cross-tenant data? (CORE-01)
2. Is RBAC -- specifically the ticket's explicit "attack hardest" instruction -- actually fail-closed for a path-scoped key, and does a path-scoped *deny* behave coherently? Can an invisible prerequisite leak status or wrongly unblock a ticket? (CORE-02)
3. Does the zero-argument tool's total absence of `inputSchema` create an injection or prototype-pollution opening? (CORE-06, MCPT-07)
4. Does the new tool inherit or weaken the shared MCP transport's origin/auth/session/lifecycle/metadata-minimization guarantees? (MCPT-01..12)

## 5. Verification method (Phase B) -- honest accounting of static vs. dynamic

No live Neo4j/Postgres in this environment. Two classes of evidence were used, and neither is overstated:

- **Static + existing-test evidence** for the graph/RBAC boundary (CORE-01, CORE-02, CORE-06's Cypher shape): the exported Cypher text, the TypeScript mapper exercised with constructed row fixtures via the existing `graph-query/index.test.ts`-style double (`GraphReadExecutor`/`PermissionStore` doubles), and the shared static `cypherOrgIdScan.test.ts` scan. This is the established, pre-existing convention for every query in this file (review.md's Warning 3 makes the identical disclosure) -- applied honestly here, not as a dodge: the assertions are specific structural regexes and mapper-rule fixtures, not `toBeDefined()` stand-ins.
- **Real dynamic HTTP evidence** for the MCP transport surface (MCPT-01, 02, 03/04/05/08, 06, 07, 12): a throwaway `tsx` script, created under the session scratchpad directory (outside the repository, never committed), spun up a real Express app mounting the actual, unmodified `createMcpGatewayRouter` (and, for the oversized-payload case, the actual production `errorHandler` from `services/core/src/http/express.ts`), and drove it over real HTTP with the official `@modelcontextprotocol/sdk` client plus raw `fetch`. Only the credential resolver and `McpToolServices` were fixtures -- exactly the same substitution `gateway.test.ts` already uses. The script was deleted immediately after use; `git status` before and after this run is byte-identical (see Cleanup).

I made one self-correction worth recording plainly: my first pass at the MCPT-07 (prototype-pollution) probe logged a "crash," and my first pass at MCPT-06 logged a false "FAIL" due to a JSON-escaping bug in my own assertion (comparing an unescaped substring against the doubly-JSON-encoded raw HTTP body). Both were re-investigated rather than reported as found: the "crash" was the MCP SDK's own `z.record()` schema validation safely rejecting a `__proto__`-keyed payload with a generic error (no pollution, no leak, no server crash -- confirmed via `Object.prototype` inspection before/after and via `JSON.parse`'s own semantics, which create an inert *own* `"__proto__"` data property, never a real prototype mutation); the "FAIL" was corrected by unwrapping the JSON-RPC envelope before substring-matching. This is disclosed because the audit contract's own standard ("a test name is not evidence; confirm what the test actually asserts") applies equally to my own scratch tooling, not only to the implementation's tests.

## 6. Mandatory core checks (CORE-01..06)

| Check | Surface | Result | Severity |
|---|---|---|---|
| CORE-01 Tenant isolation | tenant-isolation | **PASS** | NONE |
| CORE-02 RBAC boundary | rbac-boundary | **PASS** | NONE |
| CORE-03 Secrets | secret-handling | **PASS** | NONE |
| CORE-04 Webhook trust | webhook-trust | NOT_APPLICABLE | NONE |
| CORE-05 Data ephemerality | ingestion-ephemerality | NOT_APPLICABLE | NONE |
| CORE-06 Injection boundaries | injection-boundaries | **PASS** | NONE |

CORE-04/05 are `NOT_APPLICABLE`, not omitted: no webhook receiver, queue, or ingestion-worker code is touched anywhere in this diff (verified against the full changed-path list).

### CORE-02 -- the ticket's "attack hardest" instruction, answered directly

- **A path-scoped key sees zero tickets -- verified true, not merely asserted.** `Ticket`/`Feature` nodes are pathless, so every mapper/query resource check passes `path: ''`. `canReadResource`'s `ruleMatches` requires a non-null `rule.pathPrefix` to satisfy `resource.path === canonicalPrefix || resource.path.startsWith(canonicalPrefix + '/')` -- with `resource.path === ''` this is false for every non-null prefix, so a path-scoped allow rule can never match a ticket. The Cypher's allow arm requires `rule.path_prefix IS NULL` identically. Confirmed by `graph-query/ticketReadiness.test.ts`'s `'returns a repository-root-granted caller its tickets and a path-scoped caller none'` (both arms, same test, re-run clean).
- **A path-scoped *deny* does not remove a ticket** -- confirmed, and confirmed *coherent*, not a gap: the deny arm requires the identical `rule.path_prefix IS NULL` predicate (symmetric with the allow arm), so a path-scoped deny structurally cannot apply to a pathless resource in the first place -- there is no coherent way for "deny below `src/`" to mean anything for a node that has no path. This is the same, previously-reviewed posture `GET_ONBOARDING_STEPS_CYPHER` already takes for pathless `EnvStep` nodes; I diffed the two predicate blocks directly and confirmed they are character-for-character identical (only the bound node aliases differ). A **root-level** deny (`path_prefix: null`) does remove a ticket -- separately tested and passing.
- **An invisible prerequisite cannot leak status or unblock/wrongly-block a visible ticket.** The mapper nulls `status` whenever `visible` is false, at the graph-query boundary. The service layer's candidate filter requires `prerequisite.visible === true && classifyTicketStatus(status) === 'done'` for *every* prerequisite -- so an invisible prerequisite always fails this and the dependent ticket is excluded from "ready," fail-closed by construction, never the reverse (it can never wrongly *unblock*). `services/services/ticketReadinessService.test.ts`'s `'never counts an invisible prerequisite as satisfied and never leaks its identifiers'` constructs the adversarial case explicitly -- including a hidden prerequisite whose (graph-boundary-impossible, but tested anyway) status is `'Done'` -- and asserts via `JSON.stringify(result)` that neither the hidden prerequisite's id nor its status ever appears in what the MCP tool actually returns.

## 7. MCP transport / key-lifecycle brief (12 checks, real dynamic HTTP evidence)

| Check | Result | Note |
|---|---|---|
| MCPT-01 Origin/DNS rebinding | **PASS** | disallowed Origin -> 403 before any tool runs |
| MCPT-02 Auth on every method | **PASS** | missing/wrong bearer -> 401, no data leak |
| MCPT-03 Session hijacking | NOT_APPLICABLE | stateless transport, no session exists (GET/DELETE -> 405) |
| MCPT-04 Cross-session event injection | NOT_APPLICABLE | same -- no session to inject into |
| MCPT-05 Replay/resumption | NOT_APPLICABLE | same -- no persistent stream/cursor |
| MCPT-06 Lifecycle/version confusion | **PASS** (see caveat) | shared SDK doesn't enforce initialize-first server-side, but auth is still fully enforced regardless -- confirmed identical on a sibling tool, so this is inherited, not introduced by CH-02 |
| MCPT-07 JSON-RPC validation | **PASS** | `__proto__`/`constructor`-keyed payload safely rejected by SDK schema validation (no crash, no pollution, no leak); oversized payload -> safe 413 via the real production `errorHandler` |
| MCPT-08 Streaming resource exhaustion | NOT_APPLICABLE | no SSE/stream surface exists |
| MCPT-09 Key generation/storage | UNVERIFIED | unmodified by this diff; no live Postgres |
| MCPT-10 Key issuance scope | UNVERIFIED | unmodified by this diff; no live Postgres |
| MCPT-11 Rotation/expiry/revocation | UNVERIFIED | unmodified by this diff; no live Postgres |
| MCPT-12 Response/metadata minimization | **PASS** | tool listing leaks no key id/org id; generic error text confirmed |

**MCPT-06 caveat, stated plainly rather than buried:** the vendored `@modelcontextprotocol/sdk` 1.29.0 server does not require an `initialize` call before `tools/call` -- confirmed in its source and reproduced dynamically. This is **not** a CH-02 regression: it is 100% shared, unmodified code, reproduced identically against a pre-existing sibling tool (`check_liveness`) in the same run. Crucially, skipping `initialize` does **not** also skip authentication -- a control probe with no bearer token still returned `401` in the same conditions. Recorded `PASS` (no authorization boundary bypassed) with `confidence: MEDIUM` and `single_point_of_failure: true`, and flagged under Limitations rather than silently folded into a clean PASS, since only the skip-initialize-entirely variant (not repeated-initialize / capability-claim / protocol-downgrade variants) was dynamically exercised.

## 8. Review's non-blocking suggestions -- security judgment

1. **`featureGroupKey` collision** (`${feature.name} ${feature.id}` can theoretically collide across two distinct features). Judged **not security-relevant**: no cross-tenant, no cross-authorization-scope impact -- both features are already-authorized, same-tenant data the caller can see either way; at worst a display-grouping oddity within data the caller is already entitled to see in full. Correctness issue, not a security finding.
2. **Silent row-cap truncation past 4096 rows.** Judged **not security-relevant**: the truncation already fails in the *safe* direction (EC-12 drops the possibly-incomplete final ticket rather than risk showing it falsely-ready); the only gap is a missing signal to the caller, not an authorization or data-integrity risk.
3. **Path-scoped deny does not remove a ticket.** Independently verified and judged **correct, not a gap** -- see section 6 above.

None of the three rises to a finding; all three are recorded here for the record per the dispatch instructions, not folded silently into "verified clean."

## 9. Findings

**None.** Zero `FAIL` observations across all 18 selected checks.

## 10. Verified clean

CORE-01 (tenant isolation), CORE-02 (RBAC boundary, including the ticket's specific attack-hardest scenarios), CORE-03 (secrets), CORE-06 (injection boundaries), MCPT-01 (origin), MCPT-02 (auth), MCPT-06 (lifecycle, with the stated caveat), MCPT-07 (JSON-RPC/prototype-pollution/oversized-payload handling), MCPT-12 (metadata minimization) -- all affirmatively tested with static and/or real dynamic HTTP evidence, not merely asserted.

## 11. Limitations

- No live Neo4j/Postgres in this environment (see section 5).
- MCPT-09/10/11 `UNVERIFIED` -- key-lifecycle code untouched by this diff, no live Postgres to exercise it.
- MCPT-06's server-side initialize-lifecycle laxity is shared/vendored SDK behavior, confirmed pre-existing (identical on a sibling tool), not a CH-02 regression; not exhaustively tested for every sub-variant (see section 7).
- `spec.json`/`red.json` stale per `check-stamp-freshness.mjs` -- advisory per this stage's contract, not trusted-fresh; `review.json` (the trusted-fresh input) verified fresh independently before this run began.
- `poetry`-based test-impact resolver unavailable in this checkout; substituted with the full `services/core` suite (101 files / 1056 passed / 7 skipped / 0 failed), independently re-run by this stage and matching review.md's numbers exactly.
- Surfaces `llm-rag`, `model-provider`, `websocket-realtime`, `ingestion-queue-webhook`, `web-api-client`, `secrets-audit-data-lifecycle`, `supply-chain-infrastructure` are inventoried (`IMPLEMENTED`, evidenced by directory/file existence) but not audited this run -- no changed path implicates any of them.

## 12. Cleanup

One throwaway `tsx` script (`ch02-mcpt-dynamic-attack.ts`, plus two earlier debug variants `debug-mcpt06.ts`/`debug-mcpt07.ts`) was created under the session scratchpad directory (outside the repository) to drive the real gateway router over real HTTP. All three were deleted immediately after use. `git status --porcelain` before and after this entire run is byte-identical to dev's own diff (16 paths: 12 modified, 4 untracked) -- no repository file was created, modified, or left behind by this stage. No synthetic tenant data or session was persisted anywhere (in-memory Express listeners only, closed after each probe).

## 13. Recheck scope (if this ever needs re-running)

- If `mcpKeyService.ts`/`permissions.ts` key-lifecycle code is ever touched by a future ticket, re-run MCPT-09/10/11 with a live Postgres available.
- If the MCP SDK is upgraded, re-run MCPT-06 to confirm whether initialize-lifecycle enforcement changed (would currently need to change for ALL 10 tools identically, not just this one).
- If `featureGroupKey`/row-cap-signal changes are ever made (review's Suggestions 1/2), no security recheck is needed -- they were judged non-security-relevant.

# Security Audit Report

- **Run ID:** `20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa`
- **Mode:** PR_DELTA
- **Verdict:** PASS
- **Ticket:** W0-00 -- Dependency & Environment Baseline (re-derivation / audit)
- **Target commit:** `e7d473db5ac52f59a654d3ace636fa385e23e3f0` (branch `main`, worktree dirty=true)
- **Environment:** local-dev, static analysis + local Node/vitest process only. No live GitHub/Jira/Linear, production, staging, or shared target was contacted. Two disposable, self-authored dynamic probe scripts were created, run against a localhost-only Express+MCP server on an ephemeral port, and deleted immediately after use (confirmed zero residual files via `git status --porcelain`).
- **Milestone/phase:** W0-00 dependency-manifest re-derivation; pre-external-customer MVP phase (gitignored `.env` secrets posture, KMS migration PM-07 not yet triggered).
- **Baseline:** `20260727T042955000Z-fd80b6e8dc-PR_DELTA-281eeb` (commit `fd80b6e8dcb27d538c22dc72f0f804abdf09dd45`), `comparable: false` -- the baseline's diff (W2-09 GitHub installation_repositories/reconcile) shares zero observation keys with this run's diff (W0-00 dependency manifests + a two-constant MCP schema type cast). All result/coverage/readiness transitions in this run are `NOT_COMPARABLE`, per audit-contract.md section 2, rather than inventing a trend across materially incompatible target surfaces. See `manifest.json`'s `baseline.selection_reason`/`incompatible_dimensions` for the full reasoning.
- **Artifact path:** `.pipeline/security-history/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa/` (`manifest.json`, `results.json`, `report.md`)
- **Validation status:** `npm run check:security-audit-agents` passed (8 surface briefs, 108 unique checks, 2 schemas); `npm run check:security-audit-run -- .pipeline/security-history/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa` passed after two schema-conformance fixes made during this run (CORE surfaces' `brief_path` corrected to `.claude/agents/security-checker.md`; the pointer shim's own content hash added to `agent_versions` alongside `.sdd/stages/security.md`'s hash, per the validator's dual-hash requirement).

## 1. Target and environment

Diff under audit (`git status --porcelain` at run start): `DEPENDENCIES.md`, `package-lock.json` (root, generated), `services/core/package.json` (zod `3.25.76` -> `4.4.x`), `services/core/src/mcp/gateway.ts` (two scoped `as any` casts + an explanatory comment block), `services/workers/pyproject.toml` (openai pin-style normalization, no version change), `services/workers/poetry.lock` (regenerated, content-hash line only), plus two new, untracked, red-authored test scripts: `scripts/dependency-baseline.test.mjs`, `scripts/dependency-install.test.mjs`. `.pipeline/review.md` shows verdict `PASS`, clearing this run to proceed.

## 2. Security trajectory

**New:** 1 finding -- `FND-247fa22c08be` (SC-03, LOW, absence of CI dependency-vulnerability scanning). Pre-existing and repo-wide (this diff touches no CI file), surfaced because `supply-chain-infrastructure` was selected for other reasons (dependency manifests directly changed).

**Regressed:** none.

**Persisting:** none comparable -- baseline is `comparable: false`, so no prior finding can be tracked as persisting/resolved against this run's observation keys. (For the record: the 2026-07-27 baseline run's own OPEN findings -- FND-9bf079b648d0, FND-4248897cdaf3, FND-1d7f18ee0120, FND-c32772fa0c52, FND-608163fa0f1d -- are unrelated to this diff, untouched by it, and out of this run's selected-check scope; they are not resolved by this PASS and remain tracked in their own history.)

**Resolved:** none.

**Risk-accepted:** none.

## 3. Coverage trajectory

All 32 observations in this run use `coverage_transition: NOT_COMPARABLE` (baseline incompatible, per above) -- gained/lost/unchanged coverage cannot be assessed against the 2026-07-27 baseline for this diff's novel target assets. Within this run itself: 6 PASS, 24 NOT_APPLICABLE, 1 FAIL, 1 UNVERIFIED (32 total; see `results.json.summary`).

## 4. Surface readiness and documentation/code drift

14 registered surfaces inventoried (6 mandatory CORE + 8 registry agents), all `readiness_transition: NOT_COMPARABLE` (incompatible baseline). 12 `IMPLEMENTED`, 2 `PARTIAL` (`websocket-realtime` -- pre-existing, unrelated to this diff; `supply-chain-infrastructure` -- pinning/lockfile discipline solid, but no automated vulnerability scanning exists, per SC-03/SC-14 below).

Drift recorded (see `manifest.json.product_progress.documentation_code_drift`):
- DEPENDENCIES.md's `zod` row previously carried only a bare `W0-00` reference; it now explicitly names the PRD's `zod 4.4.x` line and records the `3.25.76` -> `4.4.x` bump. Manifest and documentation are now consistent with each other and with the PRD; no residual drift on this row.
- No CI dependency-vulnerability-scanning step exists in `.github/workflows/ci.yml` (confirmed by direct inspection this run) -- pre-existing, repo-wide, unrelated to this diff.
- `mcp-transport-key-lifecycle` surface readiness is unchanged (`IMPLEMENTED`, as already recorded by the 2026-07-27 baseline run) -- this diff only touches two SDK-facing type constants inside the pre-existing `gateway.ts`, not the surface's overall maturity.

## 5. Selection rationale

Mandatory CORE-01..06 always executed. Registered briefs selected via trigger-path match plus manual verification that a real, applicable target asset exists in the diff (path routing treated as a floor, not a boundary -- see `.claude/rules/security-multitenancy.md` and audit-contract.md section 5):

- **`supply-chain-infrastructure` (SC-01..14) -- SELECTED.** Direct match: `package.json`, `package-lock.json`, `pyproject.toml`, `poetry.lock` are all in the diff. This ticket's primary surface.
- **`mcp-transport-key-lifecycle` (MCPT-01..12) -- SELECTED.** Direct match: `services/core/src/mcp/gateway.ts` is directly edited, and the task explicitly asked whether the two `as any` casts weaken tool-input validation.
- **`llm-rag-poisoning`, `model-provider-egress-ssrf`, `ingestion-queue-webhook` -- NOT selected.** Path-routing floor (`services/workers/**`) technically matches via `pyproject.toml`/`poetry.lock`, but inspection of the actual diff shows zero application source under `services/workers/sayre_workers/**` is touched -- only a cosmetic `openai` pin-style normalization with zero resolved-version drift (`poetry.lock`'s diff is exactly one `content-hash` line). No prompt/retrieval/embedding/Graphify/provider-adapter/webhook/queue code exists anywhere in this diff.
- **`websocket-realtime`, `web-api-client` -- NOT selected.** No changed path matches either brief's trigger paths.
- **`secrets-audit-data-lifecycle` -- NOT selected.** Path-routing floor (`scripts/**`) technically matches via the two new red-authored test scripts, but both are pure static/mechanical checks or fixed-argument install harnesses with zero secret-loader, logging, storage, rotation, audit-log, tenant-deletion, backup, export, or detection code. SEC-01/02's substance (loader bypass, hardcoded secrets) is directly covered by the mandatory CORE-03 observation's own file-by-file secret-pattern scan across every changed file, including these two scripts.

Every non-selected surface is recorded in `manifest.json.surface_inventory` with `selected: false` and a documented `selection_reason` -- not silently omitted, per audit-contract.md section 2/orchestrator section 3.

## 6. Findings

### FND-247fa22c08be -- SC-03 / SC-14, `supply-chain-infrastructure`, LOW, OPEN

- **Evidence:** `.github/workflows/ci.yml` read in full (both the "web + core" and "workers" jobs); no step invokes `npm audit`, `pip-audit`, `poetry audit`/`safety`, a Dependabot/Snyk/Trivy/OSV-Scanner action, or any SBOM-generation step. `.github/dependabot.yml` does not exist.
- **Impact:** the codebase has no automated backstop that would catch a future CVE landing in an already-pinned dependency (e.g. a subsequent `zod` or `openai` patch release found to be compromised). This diff's own dependency changes (`zod` 3.25.76 -> 4.4.3, `openai` pin-style normalization) are not themselves flagged as vulnerable by any scanner -- because no scanner runs at all, not because they were checked and cleared.
- **Reproduction:** read `.github/workflows/ci.yml` end to end; confirm no dependency-vulnerability-scanning step exists for either the npm workspace or the Poetry project.
- **Cleanup:** none needed (no exploit performed, no vulnerable package introduced).
- **Owner / due date:** unassigned (`null`/`null` in `results.json` -- no owner nominated by this audit; recommend the repository owner triage).
- **Not blocking:** LOW severity, pre-existing, repo-wide, unrelated to and not introduced by this diff (no CI file is touched here).
- **Remediation reference:** add an `npm audit --omit=dev` / `pip-audit` (or Dependabot/OSV-Scanner) step to `.github/workflows/ci.yml`, with an owner and expiry for any accepted exceptions going forward.
- **Recheck scope:** rerun SC-03/SC-14 once a scanning step is added to `ci.yml`, or once any future dependency bump specifically claims to fix a CVE.

## 7. Verified clean

- **CORE-03 (secrets):** no live-looking credential pattern (AWS key IDs, provider token prefixes, PEM headers, inline `password=`/`api_key=`) anywhere in the six changed manifest/source files or the new `DEPENDENCIES.md` prose; the new `package-lock.json` `zod` entry is genuine registry metadata, independently confirmed against the live npm registry's own reported integrity hash.
- **CORE-06 / MCPT-07 (injection / JSON-RPC validation):** a disposable dynamic probe sent 7 deliberately malformed MCP tool-call arguments (empty string, oversized string, embedded NUL byte, leading whitespace) through the live gateway; all 7 were rejected by the server's real zod validation, proving the `NODE_ID_SCHEMA`/`QUERY_SCHEMA` `as any` casts are compile-time-only and do not weaken runtime enforcement. A matching valid call still succeeded, confirming the tool itself was not simply broken.
- **MCPT-12 (response/metadata minimization):** `listTools()` exposes exactly the 9 expected tool names with no hidden tools, internal topology, key IDs, org IDs, or stack traces; the unauthorized-response path never reflects the bearer token.
- **SC-01 (dependency integrity):** both manifest edits use pinned, non-float syntax; the new `zod@4.4.3` resolves from the standard `registry.npmjs.org` source with a verified integrity hash; `openai==2.45.*` resolves to the identical `openai==2.45.0` as before the pin-style edit (zero drift). `npm ls zod --workspaces --include-workspace-root`, rerun this pass, independently confirms the exact dual-package layout (`workspace-root zod@3.25.76` pinned by `puppeteer-core`'s transitive `chromium-bidi`; `services/core`'s own real `zod@4.4.3` nested underneath) that `changes.md`/`review.md` describe.
- **SC-02 (install/build script execution):** no install/postinstall script on the new `zod` version; both new test scripts invoke `npm ci`/`poetry install` with fixed, hardcoded arguments only, never built from untrusted/environment-influenced input.
- **CORE-01/02/04/05, MCPT-01..06/08..11, SC-04..13:** confirmed `NOT_APPLICABLE` via direct inspection of the full changed-file list -- no persistence write, Graph Query Service file, webhook receiver, ingestion-worker scratch-clone code, MCP origin/session/auth/streaming/key-lifecycle code, CI/infra/Docker/migration file is touched by this diff. See `results.json` for the specific evidence cited per check.

## 8. Limitations

- No live GitHub/Jira/Linear delivery, live Postgres/Neo4j/Redis connection, or production/staging/shared target was contacted. All findings are static code-level analysis plus (a) rerunning `gateway.test.ts` (3/3), `tsc --noEmit`, and `eslint` in `services/core`, and (b) two disposable, localhost-only dynamic probes created and deleted within this session.
- MCPT-01, 02, 03, 04, 05, 06, 08, 09, 10, 11 are `NOT_APPLICABLE` specifically because `gateway.ts`'s origin-validation, authentication, session-lifecycle, streaming, and API-key code paths are byte-identical before and after this diff. This is a PR_DELTA scoped to the actual diff, not a MILESTONE/FULL re-audit of the entire MCP transport surface -- a future MILESTONE/FULL run should still exercise those checks against the surface as a whole.
- SC-04 through SC-13 are `NOT_APPLICABLE` because no `.github/**`, `infra/**`, `Dockerfile*`, or migration file appears anywhere in this diff.
- SC-14 is `UNVERIFIED`, not `FAIL`: no vulnerability-exception artifact exists to inspect the lifecycle of, because (per SC-03) no scanner has ever flagged anything requiring one.
- This run did not itself perform a from-scratch `rm -rf node_modules && npm ci` / `poetry env remove --all && poetry install`; that specific clean-install dynamic evidence (AC-1/EC-2/EC-3/EC-7/EC-8) was independently performed and disclosed by `dev` (`changes.md`) and `review` (`review.md`) with byte-identical before/after lockfile diffs. This run instead independently cross-checked the resulting dependency-resolution claim via a live `npm ls`/`npm view` registry query.
- MCPT-12 carries a LOW-severity, non-blocking informational note: the advertised `tools/list` JSON schema for `node_id`/`query` lost its `minLength`/`maxLength` annotations after the `zod` 4.4.x bump (likely an `@modelcontextprotocol/sdk@1.29.0` schema-to-JSON-Schema conversion gap against a real zod v4 object). Real server-side enforcement is dynamically proven unaffected (see CORE-06/MCPT-07); recommend a small follow-up ticket to verify/restore full JSON-Schema fidelity for MCP tool listings under zod 4.x.

## 9. Cleanup

Two throwaway dynamic-probe scripts (`services/core/__security_audit_scratch_probe.ts`, `services/core/__security_audit_scratch_probe2.ts`) were created under `services/core/` to exercise the live MCP gateway, run via `npx tsx`, and deleted immediately after use within this session. `git status --porcelain` was rerun after deletion and shows zero residual files -- the working tree's diff is unchanged from the state at run start (`DEPENDENCIES.md`, `package-lock.json`, `services/core/package.json`, `services/core/src/mcp/gateway.ts`, `services/workers/pyproject.toml`, `services/workers/poetry.lock`, plus the two pre-existing untracked test scripts). No other test-only data, sessions, or side effects were created; no production code was modified during this stage.

## 10. Recheck scope

- **FND-247fa22c08be (SC-03/SC-14):** rerun once a CI dependency-vulnerability-scanning step is added, or once any future dependency bump specifically claims to fix a CVE.
- **MCPT-01..06/08..11:** rerun as part of the next MILESTONE/FULL audit of the MCP surface, or immediately if a future diff touches `gateway.ts`'s origin/auth/session/streaming/key-lifecycle code paths.
- **CORE-06/MCPT-07 (`as any` casts):** rerun if `NODE_ID`/`QUERY`'s own `.min()/.max()/.refine()` definitions change, or if the object passed as `inputSchema` at any of the nine `registerTool` call sites changes.
- **MCPT-12 schema-fidelity note:** rerun once a follow-up ticket addresses the JSON-Schema conversion gap, to confirm `minLength`/`maxLength` annotations are restored in the advertised tool schema.

# Security audit report

- Run: `20260807T184910201Z-e7d473d-PR_DELTA-bc1062`
- Mode: `PR_DELTA`
- Target: `ticket/fe-arch-01-workspace-packs` at `e7d473db5ac52f59a654d3ace636fa385e23e3f0` (dirty)
- Baseline: `20260807T023831742Z-e7d473d-PR_DELTA-247f84` (comparable; same commit, branch, environment, authorization ceiling, and byte-identical agent/registry/schema/checker hashes — verified by independent recomputation)
- Milestone: FE-ARCH-02 shape/renderer contract and manifest registry, extending FE-ARCH-01R before the LLM-authoring wave
- Verdict: **PASS**
- Review gate: **PASS** (`.pipeline/review.json` verdict `PASS`; `review.md`'s own `## Verdict` section agrees)

## Target and baseline

Ticket FE-ARCH-02 adds a pure shape/renderer contract package (`packages/workspace-packs/src/{shapes.ts,registry.ts}`, plus an additive `runtime.ts` re-export) and its app-side wiring (`apps/web/app/workspace/packs/{shapeAdapters.ts,rendererCatalog.tsx,capabilityCatalog.ts,componentCatalog.tsx,runtimeCatalog.ts}`), on top of the still-uncommitted FE-ARCH-01R baseline. The eight source files plus five red tests and three tester tests were isolated via the same mtime-sweep technique review.md's finding 2 used (every FE-ARCH-02-session file dates 2026-08-07 14:07 or later; the FE-ARCH-01R baseline dates 2026-08-06/earlier 2026-08-07), then cross-checked against `git status`/`git diff --name-only` — no file outside spec.md's affected-files list was touched by this ticket, and no server-side file (`services/core/src`, `services/gateway/src`, `services/workers`) changed at all.

Baseline ancestry verified: `git merge-base --is-ancestor e7d473db5ac52f59a654d3ace636fa385e23e3f0 HEAD` → ancestor confirmed (same commit exactly, since the tree remains uncommitted). Every one of the eight registered-agent content hashes (contract, registry, orchestrator, both schemas, this checker's shim and `.sdd/stages/security.md`, and `web-api-client-attacker.md`) recomputed identically to the baseline manifest's recorded values — this run is a true incremental continuation, not a fresh audit.

## Conclusion

The FE-ARCH-02 delta introduces no tenant-isolation or RBAC-boundary failure, and no CRITICAL/HIGH finding. Fourteen of eighteen selected checks PASS, two are NOT_APPLICABLE, and two are FAIL. One FAIL (`WEB-05`, application security headers) is a pre-existing, unrelated finding persisting unchanged from before this ticket. The other (`WEB-07`) is a new, genuine defect this stage discovered by testing beyond both the red and tester suites' own adversarial batteries: `isWorkspaceShapePayload` throws on a hostile property accessor or a throwing-trap `Proxy`, contradicting its own documented "never throws" contract (shapes.ts:86) and spec.md EC-04. It is rated MEDIUM, not blocking, because the function has zero live call sites today (repository-wide grep confirms this) and the architecture's stated future ingress path for external/LLM-authored payloads is always `JSON.parse`-based, which cannot itself produce a throwing accessor or a `Proxy` — so the specific reproduction here does not yet have a reachable attacker path, only a documented-contract violation that should be closed before any future caller hands this guard a live, non-JSON-normalized object. Separately, and reassuringly: the same adversarial pass found **no prototype pollution** — `__proto__`/`constructor`-bearing payloads are read but never assigned onto `Object.prototype` or any shared object, dynamically confirmed against the real module.

The presentation-only architecture claim in spec.md's "Product and architecture alignment" section holds under independent inspection: `validateBinding` can only narrow (reject) a binding, never grant one; it has no live caller yet; and the one registry output that does reach a live definition (`requiredCapabilities` on the legacy `sayre.explorer`/`sayre.pitch-summary` aliases) is byte-identical to the pre-FE-ARCH-02 hardcoded literals, referencing the same pre-existing gate namespace. No file under `services/core/src` (the Graph Query Service) changed. Nothing in this delta touches `org_id`, WebSocket transport, webhook receivers, or secrets — confirmed both by the mtime/git-status sweep (no such file appears in the eight-file delta) and by a direct grep of all eight files for `org_id|orgId|websocket|webhook|secret|apikey|api_key|process\.env|credential|token`, which returned zero matches.

## Dynamic evidence

- `packages/workspace-packs`: `npx tsc --noEmit` — clean. `npx vitest run` — 11 files / 46 tests, all pass.
- `apps/web`: `npx tsc --noEmit` — clean. `npx vitest run` — 60 files / 343 tests, all pass. `npm run lint` (`next lint`) — "No ESLint warnings or errors."
- `services/core`: `npx vitest run src/security/graphOrgGuard` — 1 file / 37 tests pass. `npx vitest run src/graph-query/permissions` — 1 file / 11 tests pass. `npx vitest run src/webhooks/githubSignature` — 1 file / 11 tests pass.
- `node --test scripts/check-secret-access.test.mjs` — 39/39 pass.
- `npm run check:security-audit-agents` — "Security audit agent validation passed: 8 surface briefs, 108 unique checks, 2 schemas."
- Adversarial probe (new this run, not present in any prior report): a Node ESM `file://` dynamic import of the on-disk `packages/workspace-packs/src/shapes.ts`, exercised directly (not reimplemented) against:
  - a JSON.parse-produced payload carrying an own `"__proto__"` property, and an object-literal payload whose nested collection item carries a `"constructor"` property — both accepted or rejected on their structural merits with **zero global prototype mutation** (`({}).polluted`/`({}).polluted3` stayed `undefined` after each probe);
  - a null-prototype object (`Object.create(null)`) — handled without throwing;
  - objects with a throwing `get` accessor on `shape`, `items`, a nested collection-item's `id`, and a nested tree-node's `parentId`, plus a bare `Proxy` with a throwing `get` trap — **all five threw**, contradicting the guard's own "never throws" contract;
  - a control `Proxy` with a throwing `has` trap (not `get`) — did **not** throw, confirming the defect is specific to property-read access, not object-shape testing generally.

## Findings

- `FND-6f66474ddfb9` — **NEW**, OPEN, MEDIUM, `WEB-07`: `isWorkspaceShapePayload` (and its four per-shape helpers) throw when handed an object with a throwing property accessor or a `Proxy` with a throwing `get` trap, on any field the guard reads at any depth. Zero live call sites exist today (grep-verified), and the architecture's stated future JSON-based ingress path cannot itself produce such an object — but this is a genuine, reproducible violation of the function's own documented contract and of spec.md EC-04, uncaught by both the red suite and the tester's own "never throws" adversarial battery (which used only a *transparent* Proxy with an empty handler). Remediation: make the guard exception-safe (e.g. wrap the dispatch in try/catch) before any future caller passes a non-JSON-normalized object into it, and add a red/tester case for a throwing-getter object and a throwing-trap Proxy.
- `FND-b47dbf6378b9` — persisting, OPEN, MEDIUM, `WEB-05`: no CSP or frame-protection headers configured in the Next app. Predates FE-ARCH-01 and FE-ARCH-02; unrelated to and unaffected by this ticket's delta.
- `FND-9dafe994fd96` — persisting, RESOLVED, NONE, `CORE-03`: secret-access/org-secret-access scanner suites remain 39/39 and 8/8 passing; carried forward for continuity of record.

New findings: 1. Regressed findings: 1 (`WEB-07`, see result-transition note below). Persisting findings: 1 (`WEB-05`). Resolved historical findings carried forward: 1 (`CORE-03`). Risk-accepted findings: 0.

**On `WEB-07`'s REGRESSED classification:** the observation key (`web-api-client|Workspace Pack client boundary`) is the same stable boundary the baseline run already tracked as PASS, so per the audit contract's literal transition rule ("baseline was PASS and current result is FAIL" → `REGRESSED`) this is recorded as a regression of that boundary's overall posture, even though the specific defect lives in a file (`shapes.ts`) that did not exist at baseline time. This is a deliberately conservative reading — see Limitations.

## Verified clean

- **Privilege escalation via pack/module binding (ticket probe 1):** `validateBinding` (`registry.ts:110-126`) only ever *rejects* — no code path adds to, mutates, or bypasses `context.grantedGates`; `roleAllows` (unchanged, imported from `parse.ts`) enforces the existing member<admin<owner ordering. It has zero live call sites (grep-verified). The one registry output that does reach a live definition — `requiredCapabilities` on `sayre.explorer@1`/`sayre.pitch-summary@1` — is byte-identical to the pre-FE-ARCH-02 hardcoded literals (`['sayre.technical']`/`['sayre.product']`), sourced from the same pre-existing gate namespace `workspaceCapabilities` already defines. No server-side file changed.
- **Registry injection / hostile manifest content (ticket probe 2):** `registerDataCapability`/`registerRenderer` reject unknown shapes (AC-01), duplicate `id@version` (EC-01), empty `allowedSlots` (EC-03), and reserved legacy `id@version` collisions (EC-06) — all re-verified by direct code reading, not merely trusted from red.md/test-results.md. Manifest `id`/`title` strings reach only a `Map` key, a JSX text/prop binding (auto-escaped by React), or a developer-facing import-time throw message — grep confirms zero `eval`/`Function(`/`dangerouslySetInnerHTML`/`child_process`/`exec(` anywhere in the eight-file delta.
- **Contract-package purity (ticket probe 3):** independently re-verified, not merely trusted from AC-13's red test: `shapes.ts` has zero imports; `registry.ts` imports only `./contracts`, `./parse`, `./shapes` (all relative, none reaching `apps/`, React/Next, or a Node builtin); a targeted grep for `fetch(`/`XMLHttpRequest`/`WebSocket`/`localStorage`/`sessionStorage`/`process.env`/`require(` across both files returned zero matches.
- **Payload guards as a trust boundary — the pollution half (ticket probe 4):** no prototype pollution occurs under either a JSON.parse-shaped `__proto__` payload or an object-literal `constructor` payload, dynamically confirmed against the real module. (The throw-safety half of probe 4 is the `WEB-07` finding above, not verified-clean.)
- **Folder/File-only adapter (EC-05):** `structureTreePayload` filters to `RENDERABLE_NODE_KINDS = {'Folder','File'}`; independently confirmed `GraphNode['kind']` is itself typed as only `'Folder' | 'File'` in `apps/web/app/workspace/types.ts:49` — Function/Class kinds cannot reach this adapter even before the runtime filter is considered.
- **Multi-tenancy rules (ticket probe 5):** the exact 8-file FE-ARCH-02 source delta (`packages/workspace-packs/src/{shapes.ts,registry.ts,runtime.ts}`, `apps/web/app/workspace/packs/{shapeAdapters.ts,rendererCatalog.tsx,capabilityCatalog.ts,componentCatalog.tsx,runtimeCatalog.ts}`) was grepped directly for `org_id|orgId|websocket|webhook|secret|apikey|api_key|process\.env|credential|token` — zero matches. Nothing in this delta touches `org_id`, WebSocket transport, webhook receivers, or secrets, confirming `.claude/rules/security-multitenancy.md` is unaffected by this ticket.

## Observation matrix

| Check | Surface | Readiness | Result | Result transition | Coverage transition | Severity | Evidence |
|---|---|---:|---:|---:|---:|---:|---|
| CORE-01 | tenant-isolation | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No server persistence/graph-query route changed; services/core organization-guard suite (37/37) reran clean. |
| CORE-02 | rbac-boundary | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | validateBinding only narrows, has no live caller; live-reaching requiredGates values are byte-identical to pre-ticket literals; services/core permissions suite (11/11) reran clean. |
| CORE-03 | secret-handling | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | secret-access suite 39/39; direct grep of the 8-file delta for secret/credential/token patterns: zero matches. |
| CORE-04 | webhook-trust | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No webhook path changed; githubSignature suite (11/11) reran clean. |
| CORE-05 | ingestion-ephemerality | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No ingestion worker path changed; registry state is in-memory only. |
| CORE-06 | injection-boundaries | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No code-construction pattern in the new contract package; closed structural validation; full package/app suites rerun clean. |
| WEB-01 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No new route/handler/endpoint; every changed file is a pure module or client component. |
| WEB-02 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No SQL/Cypher/shell/template construction; manifest strings never reach a query/shell/HTML context. |
| WEB-03 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | New renderers use plain JSX text/prop bindings, auto-escaped; no dangerouslySetInnerHTML anywhere. Caveat: the two new renderers are never mounted by any test (STATIC-only for that portion). |
| WEB-04 | web-api-client | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No HTTP mutation endpoint exists in this delta. |
| WEB-05 | web-api-client | IMPLEMENTED | FAIL | UNCHANGED | UNCHANGED | MEDIUM | No CSP/frame-protection headers; predates and is unaffected by FE-ARCH-01/02. |
| WEB-06 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Manifest interfaces are closed shapes with no org/role/owner-widening field; no external registration path exists yet. |
| WEB-07 | web-api-client | IMPLEMENTED | **FAIL** | **REGRESSED** | UNCHANGED | **MEDIUM** | isWorkspaceShapePayload throws on a throwing accessor/Proxy — see Findings. No prototype pollution found (verified clean separately). |
| WEB-08 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | Volume-stress tests (2000-item collections, 900-binding matrix) complete sub-second; no hard cap exists but no live untrusted-scale caller does either. |
| WEB-09 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No invitation/role-change/destructive business flow exists in this delta. |
| WEB-10 | web-api-client | IMPLEMENTED | NOT_APPLICABLE | UNCHANGED | UNCHANGED | NONE | No HTTP response/cache/CORS surface is added. |
| WEB-11 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | New throw messages contain only source-visible id@version strings, no internal/secret detail. |
| WEB-12 | web-api-client | IMPLEMENTED | PASS | UNCHANGED | UNCHANGED | NONE | No redirect/URL-generation/pack-import-path code changed. |

## Single points of failure

None currently — `WEB-07`'s defect has no live dependent boundary today (zero call sites). Flagged for forward attention: once a future wave wires `isWorkspaceShapePayload` (or `validateBinding`) into a live import/LLM-authoring path, that guard would become the *sole* structural gate on externally-influenced payload shape; it should be made exception-safe (this run's finding) and paired with at least one other layer (e.g. size/depth ceilings per the `WEB-08` suggestion) before that wave ships, so no single check becomes the only thing standing between hostile input and a crash or an unbounded allocation.

## Coverage gaps

- `WEB-03`'s PASS for the two new renderer Components is static-only; closing this requires the mount-level output test review.md's Warning 1 already made a condition of any wave that routes live rendering through registry bindings.
- `WEB-08`'s "no explicit ceiling" observation cannot be upgraded from PASS-with-caveat to a fully authorized resource-ceiling test until a live untrusted-scale caller exists to test against.
- CORE checks retain STATIC-only evidence for `CORE-05` (Poetry worker environment unavailable in this checkout, unchanged limitation carried from `red.md`/`test-results.md`).

## Limitations

- No live credentials, synthetic cross-tenant fixtures, external providers, shared services, production infrastructure, or browser-authenticated customer session were supplied.
- Dynamic evidence is bounded to local repository tests (`services/core`, `packages/workspace-packs`, `apps/web`), a targeted grep, and in-process adversarial-object probes run directly against the on-disk `shapes.ts` module via a Node ESM `file://` import; no browser automation, CI, cloud, backup, rotation, revocation, or external-origin infrastructure was exercised this run.
- `review.json` carries no staleness stamp (`{ "verdict": "PASS" }` only), and this worktree's `.sdd` revision predates `scripts/check-stamp-freshness.mjs`/`scripts/write-stamp.mjs`/`scripts/pipeline-contracts.mjs` (confirmed absent by direct listing) — the same absence `review.md`'s own Warning 3 and `test-results.md`'s "Staleness of required inputs" section already recorded for their stages. Per this worktree's own `.sdd/stages/security.md` (which predates the PL-04 staleness-refusal clause entirely), this is not a refusal condition. Judged against the tree in front of this stage — independent `tsc`/`vitest`/`lint` reruns, a fresh `git status`/mtime sweep, and hash recomputation of every registered agent file, all performed fresh rather than trusted — nothing appears stale.
- `WEB-07`'s REGRESSED transition is a deliberately conservative reading of the contract's literal rule (baseline PASS at this observation key → current FAIL), even though the specific defect lives in code that did not exist at baseline time; see the note under Findings.
- The two new renderer Components (`TreeListRenderer`, `PitchSummaryPanelRenderer`) remain unmounted by any test in this ticket, matching review.md's already-recorded Warning 1 and its attached condition for the wave that first mounts them.

## Cleanup

No repository file was created, modified, or left behind by this stage's testing. The `WEB-07` adversarial probes were run inline via `node -e ...` against a Node ESM `file://` import of the on-disk `shapes.ts` — all constructed objects/Proxies were local to that one-shot process and discarded on exit; each probe explicitly checked `({}).polluted`/`({}).polluted3` remained `undefined` afterward, confirming no residual global-object pollution. No scratch git repository, `.pipeline/` fixture, or other throwaway directory was created for this run; all evidence came from reading and executing the existing on-disk source and test suites plus the one-shot in-process probes above.

## Recheck scope

On remediation of `FND-6f66474ddfb9`: rerun `WEB-07` against `packages/workspace-packs/src/shapes.ts` with the same five reproduction cases (throwing-getter on `shape`, on `items`, on a nested collection-item's `id`, on a nested tree-node's `parentId`, and a bare throwing-`get`-trap `Proxy`), plus the existing `__proto__`/`constructor`/null-prototype/transparent-Proxy cases as sibling non-regression checks. No other check in this run requires a recheck.

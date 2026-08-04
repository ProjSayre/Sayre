# Security Audit Report — PL-03a (cross-runtime foundation)

**Run ID:** `20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea`
**Verdict:** **PASS**
**Mode:** `PR_DELTA`
**Target commit:** `90330fb19231113ac57f35f2c45bbe31e5447d93` (branch `feat/sdd-cross-runtime-foundation`, worktree dirty — changes staged, not committed)
**Environment:** local development checkout; static analysis + local test/validator suite execution only; no live/staging/production target, no runtime penetration test (`authorization.runtime_tests_authorized: false`)
**Baseline:** none — first-ever run recorded under `.pipeline/security-history/` for this repository
**Milestone:** PL-03a — cross-runtime foundation (`.sdd/` framework + `AGENTS.md`); `review.md` verdict `PASS` (loop 3 of 3)

This run is unusual for its stage: the diff under review is the pipeline's own security apparatus —
this stage's own definition file (moved from `.claude/agents/security-checker.md` to
`.sdd/stages/security.md`), the audit-manifest content-hash sources, and a deliberate removal of a
`PreToolUse` read-only enforcement hook for `review`/`security-checker`. Three lines of inquiry were
prioritized ahead of, and alongside, the registered checklist execution below.

---

## 1. Security-stage self-integrity (not a registered checklist ID — see "GAP" rows)

### GAP-01 — Stage-definition extraction integrity

**Claim under test:** dev/tester/review all state that `.sdd/stages/security.md`'s 99-line body is
byte-identical to `HEAD:.claude/agents/security-checker.md`'s prior body except for one intentionally
removed clause ("— enforced by a hook, not just this instruction").

**Independently verified, not taken on trust.** Extracted `HEAD:.claude/agents/security-checker.md`
(`git show HEAD:.claude/agents/security-checker.md`, confirmed 99 lines), stripped its frontmatter,
and diffed the remaining body against `.sdd/stages/security.md` from its first procedural line
("You are the security stage..."). Result: **exactly one line differs**, and it is exactly the
documented clause removal:

```diff
-You are the security stage ... read-only with respect to source code — enforced by a hook, not just this instruction.
+You are the security stage ... read-only with respect to source code.
```

Nothing else in the 99-line extraction differs — no silent truncation, no reworded procedure, no
dropped section. This is the highest-cost failure mode this ticket could produce (an agent quietly
losing its own governing instructions), and it did not happen.

**Result: PASS.** Evidence type: STATIC. Severity: NONE. Confidence: HIGH.

### GAP-02 — Audit-manifest content-hash coverage

**Claim under test:** `scripts/validate-security-audit-run.mjs`'s `requiredSources` set was updated
to hash `.sdd/stages/security.md` (the file that now actually governs this stage) alongside
`.claude/agents/security-checker.md` (now a 5-line generated pointer with no procedural content),
so the manifest's tamper-evidence isn't hollowed out by the extraction.

**Independently verified.** Read `scripts/validate-security-audit-run.mjs` directly: `requiredSources`
includes `registry.contract`, `registry.orchestrator`, `agent-registry.json`, **and both**
`.sdd/stages/security.md` and `.claude/agents/security-checker.md`, each enforced via
`assert(versions.get(source) === sha256(readRepo(source)), ...)`. Also confirmed
`scripts/validate-security-audit-agents.mjs`'s "security checker is integrated with X" assertion was
repointed from the pointer file to `.sdd/stages/security.md` (the file that actually contains the
required-reading list, checklist semantics, and report contract). Both scripts were re-run fresh this
session (`npm run check:security-audit-agents`, `npm run test:security-audit-run`) and passed.
This run's own `manifest.json` (below) hashes both files, matching the corrected requirement.

**Result: PASS.** Evidence type: BOTH (static read + executed validator). Severity: NONE. Confidence: HIGH.

### GAP-03 — Removal of the `review`/`security-checker` read-only `PreToolUse` enforcement (a control regression, judged and disclosed, not silently accepted)

**What changed.** This diff deletes `scripts/validate-pipeline-only-bash.sh` outright, reverts
`scripts/validate-pipeline-only-write.sh` to its exact pre-ticket `HEAD` content (confirmed via
`git diff HEAD -- scripts/validate-pipeline-only-write.sh`, no output), and removes the `hooks:`
blocks from both `review` and `security-checker` in `.sdd/runtimes.yml` — so the generated
`.claude/agents/review.md` / `.claude/agents/security-checker.md` shims now carry no `hooks:` key at
all (confirmed by reading both files directly: frontmatter is `name`/`description`/`tools`/
`disallowedTools`/`model` only).

**Why, and is the reasoning sound?** A loop-3 diagnostic (documented in `changes.md`,
`docs/PRD_Tickets.md`'s new `PL-03g` ticket, and this repo's own `.pipeline/review.md`) established
that a `PreToolUse` hook declared in **subagent frontmatter** never fires on this checkout — only a
hook declared in `.claude/settings.json`'s top-level `hooks:` key does (confirmed: `review`'s own
`.pipeline/review.md` write for this same ticket, on a machine with no `jq` installed, should have
been blocked by the pre-existing fail-closed write guard and was not). I re-confirmed the checkout
state directly: `.claude/settings.json` is `{"permissions":{"deny":[]}}` with no `hooks` key, no
`settings.local.json` exists, and no leftover diagnostic artifact (`hook-probe-frontmatter.txt`)
remains on disk. So the removal responds to a real, reproduced finding, not a hypothesis.

**I am the agent whose constraint this is.** `security-checker` (this session) has never actually
been prevented by tooling from writing outside `.pipeline/` — before this diff, an inert hook
declaration gave a false impression that it was; after this diff, that false impression is gone, but
the underlying technical fact is unchanged: nothing except my own adherence to this brief's
instructions and the audit contract's anti-injection rule (Section 3) stops a `Write`/`Bash` call from this
session touching a file outside `.pipeline/`. That was always true. Presenting it as neutral would be
dishonest, so I am stating it plainly per this run's instructions, not just repeating dev's disclosure.

**Is deferring a technical fix acceptable?** I judge **yes, for this run, for these reasons** (my own
assessment, not just adopting dev/review's framing):

1. **The exploit path requires a chain, not a single failure.** An attacker would need to (a) inject
   an instruction into content this stage reads as evidence (a diff, a ticket, a prior report — all
   already required to be treated as untrusted per audit-contract Section 3), (b) have that injection
   override this session's explicit read-only brief and the contract's anti-injection rule, and (c)
   have the resulting source-code write go unnoticed by the human who merges (every stage's own
   procedure, and the human merge step, involves reading `git diff`/`git status`). The one available
   empirical data point (a `review`-type subagent asked, mid this same investigation, to perform an
   out-of-scope write "as a diagnostic" correctly refused, citing the injection-shaped framing) is
   reassuring but does not cover a subtler, disguised injection — I am not treating it as proof the
   gap is unreachable, only as one data point among several mitigating factors.
2. **No technical fix is available without a human decision.** The real fix requires a
   `.claude/settings.json`-level hook, and whether that hook shape can scope itself to `review`/
   `security-checker` specifically (without also blocking `dev`, which must legitimately write code)
   is an open platform-capability question neither `dev` nor I can resolve by writing more shell
   script — `PL-03g`'s first acceptance criterion is exactly this open question, correctly framed for
   a human/agent pair, not a solo agent loop.
3. **The deferral is honestly and thoroughly recorded**, not quietly dropped. I independently verified
   (not just read dev's claim) that every place previously asserting hook-based enforcement now states
   the corrected, weaker guarantee: `CLAUDE.md:68-69,75`, `.sdd/stages/review.md` and
   `.sdd/stages/security.md`'s runtime notes, `.sdd/README.md`, `.sdd/pipeline.md`'s "Review
   persistence" section, `.sdd/runtimes.yml`'s per-stage comments, and `.pipeline/README.md`'s routing
   paragraph (this last one was flagged by tester as initially missed with an inaccurate "gitignored"
   justification, and is now corrected — I re-read it directly and confirmed the fix).
   `docs/PRD_Tickets.md`'s `PL-03g` carries a full rejected-approach catalogue (8 named bypass classes)
   so the allowlist approach isn't silently retried, and the parent `PL-03` ticket body no longer
   claims D-005 is closed (re-verified directly — no residual "Also closes D-005" language remains
   anywhere in `docs/PRD_Tickets.md`).
4. **Rejecting the design on the merits, not only the wiring, is correct.** Independent of whether the
   hook ever fired, three review/test rounds found the command-string-allowlist approach itself keeps
   producing new bypasses at a non-decreasing rate (culminating in `ruff check --config fix=true`,
   which re-enables a dangerous flag through a config *value* rather than a flag *name* — no
   denylist-by-shape can close that). Keeping that design alive under a hook that doesn't fire would
   have been strictly worse than removing it: false confidence plus a design that was independently
   proven not to converge.

**Classification.** This is a genuine, currently-unmitigated-by-tooling control gap, first observed
by this run (no prior baseline exists to call it a regression against). I am **not** rating it
CRITICAL/HIGH (which would force `BLOCKED` under this stage's own gate rules) — the impact is bounded
to this internal development pipeline's own process integrity, not a customer-facing tenant-isolation,
RBAC, or webhook-trust boundary, and multiple independent mitigating factors above reduce realistic
exploitability without eliminating it. I rate it **MEDIUM**, confidence **HIGH** (the gap itself is
proven; the exploitability judgment, not the gap's existence, is what carries uncertainty), and
**single point of failure: true** — model instruction-following is currently the *only* control.

This does not appear as a numbered `check_id` observation in `results.json` (no registered checklist
ID covers "does the security stage's own enforcement tooling work"), per the audit contract's
guidance to add a `GAP-*` row for a newly discovered surface rather than force it into an
ill-fitting existing check ID or silently drop it. It is, however, the single most important line in
this report, and I am flagging it as such rather than letting the schema's absence of a slot for it
bury it.

**Recommendation to the human merging this:** read `docs/PRD_Tickets.md`'s `PL-03g` in full before
merge. Its first acceptance criterion — a documented answer to whether `PreToolUse` carries
subagent-scoping identity — is the actual next step, and it names a human decision, not an agent
retry.

---

## 2. Registered checklist execution (`PR_DELTA`)

**Surface selection.** `git diff --cached --name-only` / `git diff --name-only` inspected directly.
Changed paths are confined to `.claude/**`, `.sdd/**`, `AGENTS.md`, `CLAUDE.md`, `docs/**`,
`scripts/**`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `.gitattributes`,
`.gitignore`. Matched against `agent-registry.json`'s `trigger_paths`:

| Brief | Selected? | Why |
|---|---|---|
| `secrets-audit-data-lifecycle` | **Yes** | `.github/**`, `scripts/**` match |
| `supply-chain-infrastructure` | **Yes** | `.github/**`, `**/package.json`, `**/package-lock.json` match |
| `llm-rag-poisoning`, `model-provider-egress-ssrf`, `mcp-transport-key-lifecycle`, `websocket-realtime`, `ingestion-queue-webhook`, `web-api-client` | No | No changed path matches any registered trigger path for these six briefs |

Mandatory `CORE-01`..`CORE-06` always execute regardless of selection.

### Observation table

| Check | Surface | Target asset | Result | Severity | Confidence | Transition | Finding |
|---|---|---|---|---|---|---|---|
| CORE-01 | tenant-isolation | PL-03a diff | UNVERIFIED | NONE | LOW | FIRST_OBSERVATION | - |
| CORE-02 | rbac-boundary | PL-03a diff | UNVERIFIED | NONE | LOW | FIRST_OBSERVATION | - |
| CORE-03 | secret-handling | PL-03a diff | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| CORE-04 | webhook-trust | PL-03a diff | UNVERIFIED | NONE | LOW | FIRST_OBSERVATION | - |
| CORE-05 | ingestion-ephemerality | PL-03a diff | UNVERIFIED | NONE | LOW | FIRST_OBSERVATION | - |
| CORE-06 | injection-boundaries | PL-03a diff | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-01 | secrets-audit-data-lifecycle | scripts/*, ci.yml, package*.json | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-02 | secrets-audit-data-lifecycle | " | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-03 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-04 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-05 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-06 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-07 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-08 | secrets-audit-data-lifecycle | " | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-09 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-10 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-11 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-12 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-13 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SEC-14 | secrets-audit-data-lifecycle | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-01 | supply-chain-infrastructure | ci.yml, package*.json | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-02 | supply-chain-infrastructure | " | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-03 | supply-chain-infrastructure | " | FAIL | MEDIUM | HIGH | FIRST_OBSERVATION (OPEN) | FND-4cad365ba4d1 |
| SC-04 | supply-chain-infrastructure | " | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-05 | supply-chain-infrastructure | " | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-06 | supply-chain-infrastructure | " | FAIL | LOW | MEDIUM | FIRST_OBSERVATION (OPEN) | FND-023dd3a498c5 |
| SC-07 | supply-chain-infrastructure | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-08 | supply-chain-infrastructure | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-09 | supply-chain-infrastructure | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-10 | supply-chain-infrastructure | " | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-11 | supply-chain-infrastructure | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-12 | supply-chain-infrastructure | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-13 | supply-chain-infrastructure | " | NOT_APPLICABLE | NONE | HIGH | FIRST_OBSERVATION | - |
| SC-14 | supply-chain-infrastructure | " | UNVERIFIED | NONE | LOW | FIRST_OBSERVATION | - |
| GAP-01 | (stage self-integrity) | security.md vs HEAD security-checker.md | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| GAP-02 | (audit-manifest integrity) | validate-security-audit-run.mjs | PASS | NONE | HIGH | FIRST_OBSERVATION | - |
| GAP-03 | (read-only enforcement) | review/security-checker PreToolUse wiring | FAIL | MEDIUM | HIGH | FIRST_OBSERVATION (OPEN, no risk acceptance) | unregistered check ID, no FND-*, tracked as PL-03g |

Full attempt/evidence/reproduction detail for every check_id-bearing row is in this run's
`results.json` (schema-valid, one observation per selected checklist ID, none omitted).

### Findings detail

**FND-4cad365ba4d1 (SC-03 - no automated dependency-vulnerability scanning gate).** `.github/workflows/ci.yml` has no `npm audit`, Dependabot/Renovate config, or SBOM step anywhere. A manual
`npm audit --omit=dev --json` against this checkout surfaced **15 existing advisories (8 moderate,
7 high)** across `@hono/node-server`, `@modelcontextprotocol/sdk`, `body-parser`, `bullmq`,
`drizzle-orm`, `express`, `fast-uri`, `next`, `path-to-regexp`, `postcss`, `qs`, `react-router`,
`react-router-dom`, `uuid`, `ws`. **None of these are introduced by this diff** - the only dependency
change here is `js-yaml@4.3.0` (already resolved transitively via `eslint`, now an explicit
`devDependency`), which does not appear among the 15 flagged packages, and none of the 15 packages
appear in this diff's changed-paths list. Severity MEDIUM: the finding is the absence of a detection
gate, not a demonstrated live exploit of any specific package in this pass; confidence HIGH (the
absence and the advisory list are both directly reproduced, not inferred). Recommend a dedicated
follow-up ticket for a CI-integrated `npm audit`/Dependabot gate - currently untracked.

**FND-023dd3a498c5 (SC-06 - third-party GitHub Actions pinned to tags, not digests).**
`actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5` are pinned to mutable
version tags. Pre-existing across the whole file - confirmed not part of this diff's 18-line addition
(`git diff --cached -- .github/workflows/ci.yml` shows only the 3 new `npm run` steps). Rated LOW
(first-party GitHub actions, common industry practice, materially lower risk than an equivalent gap in
a third-party action) rather than MEDIUM/HIGH.

Both findings are pre-existing and out of PL-03a's own scope to fix; both are first-observed by
this run only because no prior security-history run ever existed to have found them earlier.

---

## 3. Summary

- **Verdict: PASS.** No CORE-01..06 failure, no CRITICAL/HIGH failure or regression on any registered
  checklist ID, no coverage loss on a CRITICAL/HIGH boundary, no schema-invalid or overwritten run
  artifact.
- **Counts:** 34 registered-checklist observations - 10 PASS, 17 NOT_APPLICABLE, 5 UNVERIFIED, 2 FAIL
  (both non-blocking: MEDIUM, LOW). All 34 are FIRST_OBSERVATION (no baseline exists). 3 additional
  narrative GAP-* items (2 PASS, 1 FAIL/MEDIUM - GAP-03, the single most important line in this
  report).
- **New findings:** FND-4cad365ba4d1 (SC-03, MEDIUM), FND-023dd3a498c5 (SC-06, LOW) - both
  pre-existing conditions first surfaced by this run, not introduced by this diff.
- **Regressed findings:** none (no baseline to regress against).
- **Persisting findings:** none (first run).
- **Resolved findings:** none (first run).
- **Risk-accepted findings:** none - GAP-03 has no recorded risk_acceptance (no named approver,
  reason, ticket-with-expiry on file); it is OPEN, tracked informally via PL-03g, and its
  MEDIUM/non-blocking rating is my own severity judgment, not a risk acceptance.
- **Single points of failure:** GAP-03 (model instruction-following is the only control preventing
  review/security-checker from writing outside `.pipeline/`); SC-03 (no automated scanning gate -
  detection currently depends entirely on someone manually running `npm audit`).
- **Coverage gaps:** CORE-01/02/04/05 UNVERIFIED this run - full system-wide re-verification of
  tenant isolation, RBAC boundaries, webhook trust, and ingestion ephemerality requires a
  MILESTONE/FULL run against the current default branch; this PR_DELTA run correctly does not
  attempt it, since this diff touches none of that code.
- **Cleanup performed:** none required - no runtime/destructive test was run. Test artifacts: none
  created; this run only read files and executed existing npm run/node --test suites already in
  the repository.
- **Export requirement:** this run directory should be exported to an approved access-controlled
  artifact store before this worktree/machine is retired, per audit-contract Section 9.

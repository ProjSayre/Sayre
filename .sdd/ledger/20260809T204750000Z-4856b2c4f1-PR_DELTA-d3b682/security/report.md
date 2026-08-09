# Security Audit Report — W1-01 GAPFILL (GAP-5/6/7/8)

**Run ID:** `20260809T204750000Z-4856b2c4f1-PR_DELTA-d3b682`
**Verdict:** PASS

## 1. Target and environment

- Repository: `projsayre/sayre` (`https://github.com/ProjSayre/Sayre`)
- Commit: `4856b2c4f1b7455fb5d82be7c16458d7bbaf065e` (branch `main`, worktree dirty)
- Mode: `PR_DELTA`
- Environment: local-dev checkout; no live CI run; no Docker/Neo4j/Postgres reachable. The worktree
  carries unrelated in-progress changes on other tickets (`.github/workflows/`, `apps/web/`,
  `packages/config/`, `services/core/`, `infra/`, `scripts/ci/`, plus a stray untracked `Documents/`
  directory) — none of these are part of this run's target diff, confirmed by scoping every check to
  `git diff`/`git status` output filtered to `services/workers/sayre_workers/parsing` and
  `services/workers/tests` only.
- Milestone/phase: Wave 1 — W1-01 multi-language Tree-sitter parsing module, MVP audit-and-gapfill
  lane (GAP-5/6/7/8), pre-external-customer MVP phase.
- Target diff: 18 changed paths — 8 modified (`queries/javascript.scm`, `queries/typescript.scm`,
  `adapters/javascript.py`, `adapters/typescript.py`, `__init__.py`, two `expected_parse.json`
  goldens, `test_parsing.py`) + 10 created (8 fixture sources, `mixed/expected_parse.json`,
  `test_parsing_gapfill.py`). Exact match against `changes.json.filesChanged` and `review.md`'s own
  `git diff`/`git status` — confirmed independently via my own `git diff --name-only HEAD` +
  `git ls-files --others --exclude-standard`.
- Prior gate: `.pipeline/review.json` verdict `PASS`, `stamp` confirmed **fresh**
  (`node scripts/check-stamp-freshness.mjs review.json` → exit `0`) before starting.

## 2. Baseline

**No baseline selected** (audit-contract.md option 4). None of the five prior runs under
`.pipeline/security-history/` (`20260723T045054983Z-dcd04559ef`, `20260726T014535000Z-7f22125a81`,
`20260727T042955000Z-fd80b6e8dc`, `20260804T055818422Z-e7d473db5a`,
`20260809T044344000Z-fbdf003b67`) ever audited `services/workers/sayre_workers/parsing/**` as a
target surface — the nearest, `20260727`'s run, contains exactly one line referencing it as
"untouched by this diff" scope-boundary evidence for an unrelated ticket, not an audit of the module.
Every observation below is therefore `FIRST_OBSERVATION`, not a progress claim, per contract §2's
explicit instruction not to invent progress with no comparable baseline.

## 3. Security trajectory

- **New (this run):** one finding — `FND-d572b816804c` (ING-09, MEDIUM, OPEN). See §5.
- **Regressed:** none.
- **Persisting:** none tracked by this run (see §7 for an unrelated, out-of-scope open finding from a
  different run).
- **Resolved:** none.
- **Risk-accepted:** none.

## 4. Coverage trajectory

All 20 observations are `NOT_COMPARABLE` for coverage (no baseline run selected — see §2). 18
`NOT_APPLICABLE`, 1 `PASS`, 1 `FAIL`.

## 5. Findings

### FND-d572b816804c — ING-09, parser/repository resource exhaustion — MEDIUM, OPEN

**What:** `sayre_workers/parsing/adapters/base.py::ancestor_scope_chain()` walks every ancestor of
every scope-classified node up to the tree root, once per node. No file-size, nesting-depth, or
wall-clock ceiling exists anywhere in `sayre_workers/parsing` (grepped `parser.py`, `adapters/base.py`,
`adapters/javascript.py`, `adapters/typescript.py`, `registry.py` for `MAX`/`size_limit`/`timeout`/
`signal.alarm`/`ulimit` — zero hits). A file containing deeply nested named-function/class syntax
drives `parse_full()` into disproportionate CPU time with growth that is clearly super-linear in
nesting depth (empirically consistent with polynomial growth; the exact exponent was not further
derived).

**Reproduction (dynamic, HIGH confidence):**

| Depth | Nested `function* g(){}` (new: generator) | Nested `function g(){}` (pre-existing, unmodified) — current tree | Same, on a disposable pre-diff worktree checkout |
|---|---|---|---|
| 125 | 0.129s | 0.120s | 0.122s |
| 250 | 0.975s | 0.901s | 0.891s |
| 500 | 7.674s | 7.029s | 6.977s |

```
poetry run python -c "
import time
from sayre_workers.parsing.parser import parse_full
from sayre_workers.parsing.models import SourceFile
src = ''.join(f'function* g{i}() {{\n' for i in range(500)) + 'yield 1;\n' + '}\n' * 500
t = time.time()
parse_full([SourceFile(path='a.js', content=src.encode())])
print(time.time() - t)
"
```
(run from `services/workers/`) reproduces ~7s at depth 500.

**Attribution — confirmed pre-existing, not introduced or measurably worsened by this diff:**
`adapters/base.py`, `parser.py`, and `registry.py` are provably untouched by this diff
(`git diff --stat` for all three returns empty). The exact same depth series, run against **only**
pre-existing, unmodified `function_declaration` nesting, produces near-identical timings both (a) on
the current (post-diff) working tree and (b) on a disposable `git worktree add --detach
4856b2c4f1b7455fb5d82be7c16458d7bbaf065e` checkout of the pre-diff commit — confirmed via
`git diff --stat` showing zero difference for those three files, then removed via
`git worktree remove --force` immediately after use (`git worktree list`/`git status --porcelain`
confirmed clean afterward). This diff's only relevant change is adding three more node types
(`generator_function_declaration`, `generator_function`, class-expression) to `_classify_scope()`,
which now also reach the pre-existing mechanism — it does not introduce a new mechanism or worsen the
existing one's asymptotic behavior. GAP-5's 50000-symbol re-export list (0.097s) and GAP-7's 20000
sibling class declarations (0.253s) — both new constructs — scale linearly and are not a concern.

**No crash, no incorrect skip:** at every tested depth, tree-sitter's own error-tolerant C parser and
`parser.py`'s broad exception-to-`SkippedFile` boundary both held correctly — this is a worst-case
**time** finding, not a crash, not a bypass of the skip mechanism, and not an injection (see CORE-06,
§6, PASS).

**Why MEDIUM, not HIGH/CRITICAL (and therefore non-blocking):** no tenant/RBAC boundary is crossed, no
data is exposed or corrupted, growth is polynomial-but-bounded rather than unbounded/exponential, and
— per spec.md's own explicit scope statement, confirmed in this diff — `sayre_workers/parsing` is not
yet wired to any live, network-facing ingestion path in this repository (W1-05 does not exist yet); the
actual blast radius (single job delay vs. shared-worker-pool starvation across tenants) depends on
timeout/circuit-breaker wiring that is W1-05's job and does not exist to evaluate yet. This severity
call should be revisited once W1-05 lands and actually feeds real, network/attacker-reachable
repository content into this parser.

**Single point of failure:** yes — no other control in the visible call chain bounds this.

**Remediation/recheck scope:** add a nesting-depth and/or per-file byte-size ceiling to
`sayre_workers/parsing` (or to whatever wraps `parse_full`/`parse_diff` once W1-05 exists), enforced
before or during `_parse()`, with a `SkippedFile`-style reason distinct from `parse_error`. Recheck by
rerunning this exact reproduction at the same depths post-fix and confirming sub-second, roughly-linear
time; also rerun the pre-existing `function_declaration`-only reproduction, since a real fix should cap
depth generically, not just for the five new constructs this diff adds.

**Owner/due date:** none assigned by this run (no human approver named) — `status: OPEN`, not
`RISK_ACCEPTED`.

## 6. Verified clean

- **CORE-01 (tenant-isolation), CORE-02 (rbac-boundary), CORE-03 (secret-handling), CORE-04
  (webhook-trust), CORE-05 (ingestion-ephemerality)** — all `NOT_APPLICABLE` against
  `sayre_workers/parsing`: confirmed by direct code inventory (this diff and the whole module) plus
  running `test_parse_result_carries_no_tenant_or_uid_fields` and
  `test_parsing_package_imports_no_graph_queue_or_git_modules` myself (both pass) — the latter is an
  AST-based import-boundary test forbidding `neo4j`/`boto3`/`git`/`subprocess` anywhere under
  `sayre_workers/parsing`. This module genuinely has no tenant, RBAC, secret, webhook, or
  filesystem/scratch-clone surface at all — not merely undisturbed by this diff.
- **CORE-06 (injection-boundaries)** — `PASS`. `.scm` query text is 100% static, package-resource-loaded
  (`load_query_source()`, unmodified), never built from parsed content. Extracted strings
  (`module`/`symbols`/class & function names) are stored as plain fields on frozen Pydantic models,
  never re-interpreted as Cypher/SQL/shell. Constructed adversarial fixture content
  (`export * from "'; DROP TABLE x; --";`, `import fs = require("$(rm -rf /)")`) and ran `parse_full`
  on it in-memory — both produced ordinary `ParsedImport` rows carrying the literal attacker string
  verbatim, no execution, no exception. Grepped the full diff for
  `eval(|exec(|subprocess|os.system|pickle|yaml.load|__import__` — zero hits.
- **ING-01 through ING-08, ING-10 through ING-14** — all `NOT_APPLICABLE`. This diff and module contain
  no webhook receiver, no queue producer/consumer, no scratch-clone, no graph/vector write, and no
  provider API client of any kind — confirmed by the same import-boundary evidence CORE-01/03/05 already
  established, plus direct inspection that `SourceFile.path` is never used to open a real file anywhere
  in this diff (it is caller-supplied bytes, stored on output records only).
- **Full test suite, independently re-run:** `poetry run pytest tests/test_parsing_gapfill.py
  tests/test_parsing.py tests/test_parsing_tester.py -q` → 111 passed; `poetry run pytest` (full
  `services/workers/` suite) → 721 passed, 50 skipped, 0 failed; `poetry run ruff check .` → all
  checks passed; `poetry run mypy --explicit-package-bases sayre_workers/parsing` → success, no
  issues. All match dev/tester/review's self-reports exactly.

## 7. Limitations

- No live CI run executed; local `poetry`-managed `pytest` only, matching dev/tester/review's own
  disclosed environment for this run.
- No baseline run was selected (see §2) — every observation is `FIRST_OBSERVATION`, not a trend claim.
- **`FND-9dae50213232`** (CORE-01, HIGH, OPEN, first observed in run
  `20260809T044344000Z-fbdf003b67-PR_DELTA-9f2c1a`) concerns the absence of a structural org-id guard
  on the general Python worker fleet's Neo4j write call sites (`ingestion/graph.py`,
  `enrichment/enrichment_graph.py`, `dynamic_coverage/graph.py`). Those files are untouched by this
  diff and outside `sayre_workers/parsing` (which has zero graph I/O of any kind, confirmed by this
  run's own CORE-01 observation, §6). **Not re-verified by this run**; remains open under its own
  finding id in a different run's history, unaffected by this run's `PASS` verdict.
- ING-09's finding (§5) was probed at nesting depths up to 500 (and a spot-check at 3000-level nesting,
  which the initial unbounded probe hit a 2-minute tool timeout on before depths were reduced for
  controlled measurement) and at up to 50000 re-export symbols / 20000 sibling declarations — not an
  exhaustive characterization of the full failure surface (e.g. mixed nesting of multiple construct
  types simultaneously, or byte-size-only attacks with shallow nesting, were not separately probed).
- No live network/attacker-reachable path into `sayre_workers/parsing` exists yet in this repository
  (W1-05 is explicitly out of this diff's scope per spec.md) — ING-09's real-world severity should be
  re-assessed once that wiring lands.

## 8. Cleanup

- Every adversarial `parse_full()` probe used purely in-memory `SourceFile` objects constructed inside
  disposable scratch scripts — never written into the repository.
- One disposable `git worktree add --detach 4856b2c4f1b7455fb5d82be7c16458d7bbaf065e` was created at a
  uniquely-named scratchpad path for pre-diff/post-diff timing isolation, and removed via
  `git worktree remove --force` immediately after use; `git worktree list` and
  `git status --porcelain` were both re-checked afterward and show no leftover path or repository file
  created, modified, or left behind by this run outside the immutable
  `.pipeline/security-history/<run-id>/` artifacts and the mutable `.pipeline/security-report.md`/
  `.pipeline/security.json` handoff files this stage is required to write.
- No production source file was read-modified; this run is read-only with respect to
  `services/workers/sayre_workers/parsing/**` and every other source path.

## 9. Recheck scope

Precise scope for a future `REMEDIATION_RECHECK` against `FND-d572b816804c`: rerun the exact
reproduction in §5 (generator-nesting and plain-function-nesting depth series at 125/250/500) plus a
sibling check using bound class-expression nesting (not separately timed in this run — it reaches the
same `ancestor_scope_chain()` mechanism and should be included once a fix lands), and confirm
sub-second, roughly-linear time after a depth/size ceiling is added.

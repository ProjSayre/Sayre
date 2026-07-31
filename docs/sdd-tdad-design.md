# SDD/TDAD methodology — design

**Status:** design approved 2026-07-31, not yet planned or implemented.
**Origin:** onboarding a nontechnical cofounder (Victor) working through a Codex account, against
the existing five-agent pipeline.
**Related decisions:** D-005 (SDD port), D-014 (clone-to-running test), D-016 (containerization),
D-017 (E2E seam, operational layer), D-018 (tests written against the implementation), D-019
(multi-client config), D-020 (ephemeral plans, PR templates), D-021 (TDAD, loop engineering),
D-022 (Position B).

---

## Problem

Three problems, one design.

**1. The Codex setup is unshareable.** `AGENTS.md`, `.agents/`, and `.codex/` are excluded via
`.git/info/exclude` lines 9–11 — machine-local by design. A `git clone` delivers `.claude/` only,
which Codex cannot read. Everything else here is downstream of fixing that.

**2. The mirror has already drifted semantically.** `.claude/skills/pipeline/SKILL.md` has `review`
writing `.pipeline/review.md` itself; `.agents/skills/pipeline/SKILL.md` has the coordinator saving
the agent's returned markdown verbatim. Two different trust models for the same gate. This is
D-014's hand-maintained-artifacts-drift lesson and D-020's "mirrored skill dirs imply a sync step
worth copying," already happening at 18 files.

**3. Tests ratify the implementation.** D-018's finding: `tester` reads `.pipeline/changes.md` — the
diff — so tests faithfully lock in bugs and pass while doing it. D-021's TDAD result carries the
constraint that makes this urgent: **TDD procedural instructions without targeted test context
raised regressions to 9.94%, worse than the 6.08% no-intervention baseline.** Telling an agent to
write tests makes things worse unless it knows which tests matter. For a nontechnical contributor
this is the difference between a safety mechanism and a hazard.

---

## Decisions locked

| Question | Decision |
|---|---|
| Victor's lane | Product code, fenced to a declared path scope |
| Gate | PR review — human by default, with a `pr-review` agent for speed and bounds checking |
| TDAD depth | Full bipartite test-impact map, v1 local / v2 graph-backed |
| Checkpoints | One hard gate at spec approval, then unattended to PR |
| Cross-runtime sync | Runtime-thin pointers (B) plus a thin generator for the irreducible frontmatter (A) |
| Behavioral tests | **All** authored from spec, before implementation exists |

This evolves `/pipeline` into the house methodology rather than creating a parallel beginner track.
Two pipelines is the drift problem this design exists to eliminate.

---

## 1. Cross-runtime foundation

A tracked `.sdd/` directory holds the methodology once, runtime-neutral:

```
.sdd/
  stages/{planner,red,dev,tester,review,security,pr-review}.md
  bounds.md          # named lane vocabulary the pr-review agent checks against
  runtimes.yml       # per-agent tool grants and model tier
  ledger/            # one committed entry per completed run
  README.md          # entry point — also Victor's documentation
```

Runtime files become ~10-line shims. `.claude/agents/planner.md` keeps its frontmatter (tools,
model, hooks) plus a pointer to `.sdd/stages/planner.md`; `.codex/agents/planner.toml` keeps its
TOML and points at the same file. Methodology lives once; only what genuinely differs is
duplicated.

**Generator.** One script emits the shims from `.sdd/runtimes.yml`. CI fails if committed shims
don't match regenerated output — D-018's "collection as generated, versioned artifact." Output is
small enough to eyeball, which is what pure-generator approaches lose.

**Secondary benefit that is not secondary:** Victor can read `.sdd/stages/planner.md` and understand
the methodology without knowing what a Claude Code subagent is. The neutral layer doubles as his
documentation, which is most of the "easy to use" requirement.

**Folded in, because they are prerequisites rather than extras:**

- Move `AGENTS.md`, `.agents/`, `.codex/` out of `.git/info/exclude` and commit them.
- Rewrite `AGENTS.md`. It currently states *"the current checkout is a Vite/React site"* — half-true
  (the root is Vite; the monorepo is also there) and the first thing Victor would read. Make it a
  pointer to `.sdd/README.md`, the pattern D-019 noted in `genesis/infra/aws`.
- Close D-005's action item: `review` and `security-checker` are documented read-only and enforced
  by a `PreToolUse` matcher on `Write`, but both carry `Bash` and no matcher covers it — `sed -i`,
  `tee`, `python -c` all write past the guard. Add the `Bash` matcher. This design adds a third
  read-only agent, so the hole widens if left.

**Out of scope:** cross-runtime parity testing (running a fixture ticket through both runtimes and
diffing artifacts). Requires Victor's Codex seat in CI. Revisit if drift survives the generator.

---

## 2. The impact resolver

### Why not the graph, yet

Sayre already ships the TDAD primitive: `get_covering_tests` is a real MCP tool returning
`coverageStatus`, `edgeStatus: inferred|measured`, `lastRun`, and `freshness: inferred|fresh|stale`,
backed by `Test` nodes, `COVERS` edges, migration `004_test_covers_contract.cypher`, static
inference in `services/workers/sayre_workers/parsing/coverage.py`, and W4-03's measured nightly
refresh. This is not a stub.

It is still the wrong backend today, for three reasons:

1. **It would return nothing extra.** Every COVERS edge on Sayre's own repo would be `inferred`,
   never `measured`, because `measured` requires the W4-03 nightly against an operator-configured
   coverage-instrumented CI adapter that has never run here. `inferred` edges are produced by
   `parsing/coverage.py` — a pure, graph-free module. Routing through Neo4j returns the identical
   answer, with a distributed system in the middle.
2. **No weighting.** TDAD weights edges by call depth and coupling, and that ranking is the point —
   it is what keeps the returned set small enough to *be* targeted context. `COVERS` is unweighted
   `Test -[:COVERS]-> File`. Backwards-traverse from a hub module and you get much of the suite.
3. **The seam is unproven.** Graph-backed means webhook→SQS→parse→Neo4j→query working end to end on
   Sayre's own repo — D-017 #1's exact gap, with no Dockerfiles underneath it (D-016).

### The interface

```
get_affected_tests(changed_paths) -> {
  tests: [{ path, depth, coupling, rank }],
  truncated: { shown, total, reason },
  confidence: "high" | "partial",
  unanalyzable: [{ path, reason }]
}
```

**v1 (now):** local resolver over `sayre_workers.parsing` + `coverage.py`. The parsing package is
documented as *"pure, in-memory, graph-free"* and already ships adapters for **Python, JavaScript,
TypeScript, and Go** — the whole monorepo is covered on day one, both the 435 TS/TSX and the 140
Python files, with no infrastructure and no seam. It is a genuine dogfood of the core algorithm,
just not of the distributed pipeline.

**v2 (trigger-gated):** same signature, body swapped to `get_covering_tests` over MCP.
**Trigger:** the nightly dynamic-coverage run produces `measured` edges for Sayre's own repo. Until
then the graph is strictly worse. At switchover, run both and diff — v1 becomes the validation
harness for v2.

### Layering

`parsing/` explicitly forbids git, subprocess, and repo-walking. So the resolver is an impure shell
around a pure core: a script does the `git diff` and file reads, hands bytes to the parser, feeds
`coverage.py`. Lands as `services/workers/scripts/affected_tests.py`, matching the convention of
`run_local_ingestion_consumer.py` and siblings.

### Ranking

Build the import graph, classify tests via the shipped `is_test_file`, compute shortest import-hop
distance from each test to each changed file. Rank by min depth ascending, then coupling descending
(distinct changed files the test reaches), then path proximity. Traversal caps at depth 3.

### Honest limits

Three separate disclosures, following D-006's anti-silent-skip and D-015's report-confidence-not-
certainty:

- **Truncation is stated, never silent:** *"showing 15 of 63 — 48 omitted at depth ≥ 3."*
- **Unanalyzable files are named.** Dynamic imports, re-export barrels, unresolvable specifiers.
- **Files with no language adapter get their own category.** The monorepo contains `.cypher`
  migrations, SQL, and YAML the parser does not read. A change to `004_test_covers_contract.cypher`
  must report *"no import-graph signal for this file"* — **not** *"no tests affected."* Those two
  outputs look identical and mean opposite things, and the second is exactly the quiet false
  "you're covered" that D-015 names as the dangerous output in a safety-adjacent feature.

**Freshness by construction:** computed at pipeline start, cached in `.pipeline/` keyed by git tree
hash. No committed artifact, so no staleness and nothing to drift.

**Boundary:** this answers *which existing tests are affected*. New behavior has no test yet — that
is the `red` stage's job.

---

## 3. Pipeline stage changes

Sequence becomes **planner → red → dev → tester → review → security**, with `pr-review` after the
PR opens.

### The `red` stage (new)

Reads `spec.md` and the impact map. Authors **every behavioral test for the spec's acceptance
criteria and edge cases — before `dev` runs.** At that moment the implementation does not exist, so
those tests cannot have been shaped by it. This is not a rule an agent follows; it is a property of
the ordering, and it is the structural version of "tests written from spec."

Runs them, confirms each fails **for the right reason** — behavior missing, not import error or
typo. A test that fails because it is broken is not leading-red, it is noise, and distinguishing
those is most of this stage's job. Writes `.pipeline/red.md`: test paths, what each asserts,
observed failure output, and the failure-mode confirmation.

Runs on the `opus` tier for the same reason `planner` does: low volume, high judgment, and errors
propagate through every downstream stage.

**Guardrail — `dev` must not make tests pass by weakening them.** `red.md` records each test file's
content hash; `review` and `pr-review` fail the run if a hash changed without an explicit justified
entry in `changes.md`.

This is **verification, not prevention**, deliberately. Prevention means a Claude Code hook, which
does not exist in Codex, so the guarantee would silently not apply to exactly the person it is meant
for. Cross-runtime guarantees cannot rest on hooks. And when the spec genuinely was wrong the tests
*should* change — they just have to be declared, which produces the paper trail D-005 #3 asked for.

**Accepted cost:** if `planner`'s signatures are wrong, the whole red suite needs rewriting once
`dev` discovers it. This is a feature — it forces a declared spec amendment instead of letting the
implementation quietly become the spec.

**Remaining soft edge, stated rather than hidden:** a test author must read source to write a
compiling test (import paths, signatures). The guarantee is not "never saw the implementation," it
is "**the assertions predate it.**" Every new behavioral test carries a spec reference (`@spec
AC-3`); `review` and `pr-review` reject any lacking one or citing a nonexistent item.

### `tester` rewired

- **Does not take `changes.md` as an input for deriving assertions.**
- Runs the red suite and the impact map's ranked affected tests; reports regressions. Nothing does
  this today, and it is the half TDAD actually measured.
- Adds only non-behavioral coverage — type-level, fixtures, harness.

### Institutional memory

`.gitignore` has `.pipeline/**` with only `README.md` exempted, so every run overwrites the last.
D-005 #5 and D-020 #4 flagged this independently from two teams.

**A committed ledger, not committed working files.** Working files (`spec.md`, `changes.md`,
`test-results.md`, `review.md`) stay gitignored — per-run scratch, and committing them means noise
and merge conflicts. `.sdd/ledger/` gets one entry per completed run: date, ticket, spec Goal, files
touched, verdicts, red-test paths, security run id. `pr-review` reads it for what past runs decided.

**Open decision:** `security-history/` also falls under `.pipeline/**`, so the immutable audit
artifacts CLAUDE.md describes exist only on the machine that ran them. For a company whose pitch is
auditability that is worth a gitignore exemption, but it puts security findings about your own code
in the repo — a deliberate choice, not an obvious fix.

### Two items from D-005, cheap

**Sanctioned hotfix path.** D-005 #3: with no sanctioned bypass, the first 2am incident bypasses it
unsanctioned and leaves no record. `/hotfix` skips stages but requires a ledger entry. **Not
available in Victor's lane** — the first natural demonstration of the bounds mechanism.

**The fully-specified-ticket trap.** D-005 #6: a ticket enumerating every file path still routes
through the full pipeline; completeness is not exemption. Stated explicitly in `.sdd/README.md`,
because a detailed ticket is precisely what tempts someone into skipping `planner` — and Victor's
tickets will be detailed by design.

### Unchanged on purpose

`security-checker` keeps its stage, post-`review`-PASS gating, 9 attacker briefs, and immutable
artifacts. D-005 found this stage leads both company estates and a port should not dilute it. Only
addition: it receives the red-test hashes so the same verification applies at the security gate.

---

## 4. The `pr-review` agent

**The failure mode this guards against is helpfulness, not malice.** Victor's agent, handed a
frontend ticket, notices a bug in `services/core/src/graph-query/` and fixes it on the way past.
Good instinct from a coding agent, bad outcome in a fenced lane, because it lands unreviewed changes
in the tenant-isolation code the Position B pitch rests on. Designing for that case keeps the
mechanism proportionate.

### Bounds as named lanes, checked deterministically

`.sdd/bounds.md` defines lanes once; tickets reference one:

```
lane: frontend    → apps/web/**, docs/**, tests within those
lane: full        → everything
```

Named lanes beat per-ticket path lists: less to get wrong, reusable, defined once rather than
authored per ticket.

**The bounds verdict is computed by a script, not judged by the agent.** `git diff --name-only
base...head`, glob-match each path against the lane, emit violations. An LLM asked "did this stay in
bounds?" can hallucinate a pass; a path match cannot. Same instinct as D-006's numeric CI gate
versus "does this feel janky." The agent reports the script's verdict and does the parts that need
reading.

### Lenses

Output is structured as separate lenses rather than one blended verdict — D-005 #2's finding that
specialized critics catch what an averaged prompt misses:

- **Bounds** — the script's verdict, plus whether any out-of-lane change was justified
- **Red-test integrity** — did a test hash change without a declared reason
- **Spec trace** — does every new behavioral test cite a real spec item
- **Spec conformance** — does the diff deliver `spec.md`'s Goal, and only that
- **Test adequacy** — did the impact map's affected tests run, were regressions addressed
- **Architecture rules** — the three `CLAUDE.md` "Don't"s plus applicable `.claude/rules/`. D-005 #4
  called these "currently hope"; this is the first thing that checks them, though a reviewing agent
  is weaker than Semgrep and D-018 #2 remains the real answer.
- **Limitations** — what the author did *not* do (velen's MR template, D-020 #3)

Splitting these into separate critic agents is the trigger-gated upgrade if one lens consistently
underperforms.

### How it runs

**On demand: `/pr-review <PR#>`.** Writes `.pipeline/pr-review.md` locally. Posting to the PR is an
explicit opt-in flag, not the default.

A GitHub Action on PR open is the natural follow-on, gated rather than built now: **trigger when
waiting for a human becomes Victor's bottleneck.** It costs CI spend and an API key in CI, and D-006
already found the workflow runs every PR twice with no caching — worth fixing before adding load.

Reviews **any** PR. Bounds reports "lane: full, no constraint" for unfenced authors.

`pr-review` is the third read-only agent and inherits D-005's `Bash` hole — covered by the Section 1
fix, now protecting three agents.

**Also:** a PR template with velen's sections — per-area changes, Testing, and Additional Info /
Limitations. Twenty minutes of work, and it is the structured input both the agent and the human
reviewer need.

---

## 5. Victor's surface

**Tickets** arrive as GitHub Issues (not `docs/backlog.md`, which is superseded), using a template
carrying `lane: frontend`, a plain-English goal, and acceptance criteria stated as things a human
can see or click.

**One command**, the same one everyone uses: `/pipeline <issue>` (`$pipeline` in Codex).

**The spec gate — his one decision.** Raw `spec.md` is written for `dev` and contains exact
signatures he cannot evaluate. So `planner` writes a plain-English **Ticket Check as the first
section of the same file** — not a companion document, which would drift. Four items: what I am
about to build · what I am explicitly not doing · how you will know it worked · what I had to guess.

He answers one question: **"Is this what the ticket asked for?"** That is squarely within his
competence — arguably more so than an engineer's, being closer to intent and undistracted by
implementation. Framing it as approving **intent, not implementation** is what stops it degrading
into a rubber stamp. If he says no, `planner` re-runs with his correction: the cheapest loop in the
pipeline and the right place to spend iterations.

**Three outcomes, never seven.** A run can stop in seven places; he sees three:

- **PR opened** — here is the link
- **Need your answer** — a plain-English question about intent or scope
- **Needs Phillip** — technical blocker, artifacts packaged for handoff

The load-bearing part is the last distinction. A nontechnical contributor's worst state is being
stuck without knowing whether to escalate; making "is this mine or Phillip's?" an explicit output
rather than an inference is most of the usability.

**Never touches:** model selection, agent definitions, judging security findings, overriding a
bounds violation, `/hotfix`.

### Two honest limits

**Comprehension debt is relocated, not solved.** D-021 names it as the hazard of loop engineering.
The spec gate does not eliminate it — Victor still ships code he has not read. What the design does
is bound *who carries it*: the lane keeps it out of security-critical paths, and PR review is where
it is paid down.

**The prerequisite currently failing.** All of this assumes Victor can clone and run the repo.
D-014's own acceptance test — *"can a new cofounder go `git clone` → running stack using only their
own credentials, with no human in the loop?"* — fails today: no Dockerfiles (D-016's blocking gap),
Doppler set up by hand, `DEV_ORG_ID` seeding SQL buried in an `.env.example` comment. And the impact
resolver is Python, needing the workers' Poetry environment with Tree-sitter's native grammars, so
even a pure-frontend ticket drags in the Python toolchain.

This promotes **D-004's devcontainer from nice-to-have to the delivery mechanism for Victor's
environment**, and makes D-016's containerization a hard prerequisite rather than a parallel track.
D-022 already sequenced containerize-first; this is a second, more concrete reason.

---

## Scope

**Built new (5)**
`.sdd/` neutral layer + shim generator · `affected_tests.py` impact resolver · `red` stage agent ·
`pr-review` agent + deterministic bounds script · `.sdd/ledger/`.

**Changed (7)**
`tester` rewired off `changes.md` · `review` gains red-hash and spec-trace checks · `planner` gains
the Ticket Check and affected-tests sections · `.claude/agents/*` and `.codex/agents/*` become
shims · `AGENTS.md` rewritten as a pointer · `.git/info/exclude` entries moved to tracked ·
`.gitignore` for the ledger.

**Fixed in passing (2)**
D-005's `Bash` hole in read-only agents · the `/hotfix` paper trail.

**Unchanged**
`security-checker` entirely.

**How much of TDAD**
The impact-map mechanism and depth/coupling ranking. Not the SWE-bench harness or the paper's
weighting constants — the structure, not the numbers.

**How much of SDD (against D-005's six recommendations)**
Adopting: critics-as-lenses, hotfix-with-ledger, committed ledger, fully-specified-ticket rule.
Not adopting: the router skill (nothing to route between yet) and hooks-as-enforcement (Codex has no
hooks — replaced by verification; Semgrep per D-018 #2 remains the real answer).
Explicitly not ported: multi-repo staging, the 109-spec index, GitLab hooks.

---

## Build order

Containerization and `BOOTSTRAP.md` sit in front of all of it and are **out of this design's
scope** — tracked as PL-01 and PL-02.

1. Cross-runtime foundation (Section 1) — unblocks everything, and is the only part that helps
   Victor before containerization lands
2. Impact resolver v1 (Section 2)
3. Pipeline stage changes (Section 3) — depends on 2
4. `pr-review` agent (Section 4) — depends on 1 and 3
5. Victor's surface (Section 5) — depends on all, and on PL-01/PL-02

---

## Open questions

1. **Commit `security-history/`?** Auditability argues yes; putting security findings about your own
   code in the repo argues for deliberation. Not blocking.
2. **Does `red` authoring the full behavioral suite front-load too much when specs are wrong?**
   Accepted as a feature here, but the first three runs should be watched for whether rewrite churn
   exceeds the value of the guarantee.
3. **Where do Victor's tickets come from?** This design assumes GitHub Issues with a lane template;
   `docs/PRD_Tickets.md` remains the authoritative backlog, so the mapping between the two needs a
   convention.

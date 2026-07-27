# Onboarding view graph

How the Onboarding view works, and why it is not a second Technical tree.

This document covers the **view**. The generation and sandboxed-execution contract
for `EnvStep` workflows is unchanged and still lives in `docs/onboarding-tree.md`.

## Problem

The Onboarding view is currently a strictly weaker Technical tree. It builds the
same `Folder`/`File` nodes, lays them out on the same depth-by-row grid, and
mounts `TechnicalTreeCanvas` as its renderer — with `CONTAINS` edges only, where
the Technical tree also has `IMPORTS`. A new hire is shown *less* structure than
an engineer who already knows the codebase.

The two views answer different questions and should not share a graph:

| | Technical tree | Onboarding view |
|---|---|---|
| Question | what imports what | what do I learn, in what order |
| Scope | exhaustive | prerequisite closure of one target |
| Edges | `CONTAINS` + `IMPORTS` (two meanings) | prerequisite only (one meaning) |
| Layout | depth by row | topological layers |
| State | stateless | done / current / locked |

A second problem is larger, and it reframes the whole feature: **structural
navigation was never the expensive part of onboarding.**

## What the evidence says

External research, gathered before committing to this design. Sources are listed
so the claims can be re-checked rather than inherited.

**Most onboarding pain is not visible in a repository.** Sorting the known pain
areas into what a repo shows, what an integration could show, and what only a
human knows gives roughly **10–15% / 25–30% / 55–65%**. The repo-visible slice is
also the one commoditising fastest, because a codebase-aware assistant already
answers most of it.

- Steinmacher et al., systematic literature review on newcomer barriers (*Information
  and Software Technology*, 2015; 291 studies screened): five barrier categories —
  finding a way to start, social interactions, code issues, documentation problems,
  prior knowledge. **One of five is code.** Social barriers appear in 75% of the
  analysed studies.
- Google, survey of 3,000+ new engineers: top blockers are learning new technology,
  missing or poor documentation, and **finding the right expert**.
- Microsoft, *A Case Study of Onboarding in Software Teams* (ICSE-SEIP 2021; 32
  developers and 15 managers interviewed, validated at n=189): the most effective
  accelerators are **verbal communication and pair programming**. Read inversely,
  the binding constraint is human-transferable knowledge.
- DORA has **never measured onboarding**, in any edition 2014–2024. Documentation
  quality entered only in 2021: ~25% of teams have good internal documentation, and
  those teams are 2.4× more likely to show better delivery performance.

**Rationale is mostly absent from git.** Roughly 44% of commit messages omit either
the what or the why, and message quality degrades over a project's lifetime. Commit
history records the change, not the reason. Conventional Commits encodes *what*
(`feat`/`fix`/`chore`) for changelog automation — it does not capture *why*.

**Documentation mechanisms fail predictably.** Of 921 GitHub repositories containing
at least one markdown ADR, about half contain only one to five — tried, not adopted.
The mechanisms that survive share three properties: they live in the repo, they are
updated in the same change as the code, and they are **immutable** (superseded, never
edited). Backstage TechDocs is the one with real telemetry — roughly 20% of all
Backstage traffic from a single plugin out of 130+ — and it survives on placement,
not format.

**Trust collapse is binary.** One stale document causes readers to distrust the whole
corpus and revert to asking people directly. A 70%-accurate knowledge base is worth
much less than 70% of a correct one. This is the governing constraint on everything
below.

**A near-identical product failed.** CodeSee — automatic codebase maps, code tours,
change visualisation, sold explicitly for onboarding — was acquired by GitKraken on
14 May 2024 and **the standalone product and brand were sunset**. The maps and team-tour
features are gone; only some review-map ideas survive inside GitKraken. CodeSee had
raised roughly $10M. An exit at approximately 1× capital after five years is a failure
with better manners.

**The genre has failed repeatedly, and not for rendering reasons.** A systematic review
of 32 studies of software solutions for newcomer onboarding (Santos, Felizardo, Gerosa
& Steinmacher, arXiv:2408.15989) found most solutions are web-based, most are evaluated
in laboratory experiments, and **many onboarding barriers remain unaddressed**. Twenty
years of tools; the barriers that persist are social, cultural, and documentation-related.
An import graph addresses approximately none of them.

**Knowledge loss is the normal state, not an edge case.** Nourry et al. (arXiv:2412.00313,
36,000+ OSS projects) found **89% of projects have lost their core development team at
least once**, 70% of those within the first three years, and **only 27% attracted a
replacement core developer**. The earlier Avelino et al. study (133 projects) found 46%
have a truck factor of 1 and 28% have 2.

**Every close comparable has abandoned or demoted the standalone "help a human
understand this codebase" product.** Verified July 2026:

| Tool | Was | Is now |
|---|---|---|
| Swimm | code-coupled docs, per-seat | enterprise mainframe modernisation, priced per line of code |
| Unblocked | "talk to your codebase" | lead SKU is Code Review $19; codebase Q&A moved *up* to $29 |
| Greptile | repo chatbot + API | PR review agent, $30/seat |
| Sourcegraph Cody | freemium code search + AI | Free and Pro killed 23 Jul 2025; enterprise only |
| CodeSee | codebase maps | acquired by GitKraken 14 May 2024; `codesee.io` now returns 404 |
| Sourcetrail | paid code explorer | archived Nov 2021 |

None of them died of bad technology. Each migrated to a market where **the payer is not
the reader**. Sourcetrail's founder stated the cause plainly on open-sourcing it in 2019:
*"an abundance of free developer tools and a lack of recognition of Sourcetrail's
advantages that the commercial paywall made too much of an investment to overcome."*
That is truer in 2026, because codebase Q&A now ships inside an IDE seat the buyer
already pays for.

**The operative conclusion: there is no onboarding budget.** There is a platform budget,
a code-quality budget, a modernisation budget, and a key-person-risk budget. Onboarding
has to be the outcome this feature is measured by, not the thing it is sold as.

Note also that Swimm's auto-sync **technically solved** doc-code staleness — including
the hard part, knowing when it *cannot* re-sync and filing a human task rather than
drifting silently — and the company pivoted anyway. Rot beating the tool was not the
failure. Beating rot was not worth a seat price.

## Thesis

**The graph is not the knowledge base. It is the routing and attachment substrate.**

Its job is to answer four questions humans are bad at:

1. What is worth asking about?
2. Who should be asked?
3. When is the cheapest moment to ask?
4. Where does the answer belong so it is found again?

The answer itself always comes from a person. The graph earns its place by making
human knowledge capture cheap and targeted, not by replacing it.

This is a narrower claim than the original design made, and it survives the
displacement question: an assistant with repo access can explain any file, but it
cannot tell you what nobody wrote down, and it cannot tell you which of two
plausible implementations is the live one.

## Design

One graph, three altitudes. It holds together because **every edge means the same
thing at every altitude: "understand this before that."** Descending an altitude is
a zoom, not a context switch.

### The prerequisite edge is derived, not stored

If A imports B, B must be understood before A. The prerequisite relation is
therefore reversed `IMPORTS`, computed in the Graph Query Service at read time.

**No new relationship type.** The closed 13-type edge set in
`packages/graph-schema/schema.md` is unchanged.

### Altitude 0 — ground rules (not a canvas view)

Everything you must know before touching anything: environment, rituals, and
conventions. This renders as a **stepper panel beside the canvas, not as graph
nodes**, for two reasons:

1. Setup is 5–15 items with light prerequisites. A checklist communicates that
   better than a DAG. Drawing it as a graph would be graph-for-graph's-sake.
2. `EnvStep` is repo-scoped while `Folder`/`File` are path-scoped. Keeping steps
   off-canvas preserves the RBAC boundary stated in `docs/onboarding-tree.md`:
   path-only grants cannot read or execute setup commands.

`assertWorkflow()` and the existing `REQUIRES` DAG validation are unchanged; they
drive step unlocking rather than node layout.

Contents are **derived**, so they cannot drift from the code:

| Content | Source |
|---|---|
| Commands and gates | `package.json` scripts, `turbo.json` tasks, and equivalents per ecosystem |
| **What must pass before merge** | **`.github/workflows/*.yml` — every `run:` step** |
| Runtime versions | `.nvmrc`, `engines`, `.python-version`, `.tool-versions`, Dockerfile `FROM` |
| Services to run | compose file `services:` keys |
| Config surface | env-var references in source, diffed against committed `*.env.example` |
| Conventions | `.claude/rules/*.md`, `coding_style` / `comment_style` node properties |

**CI is the highest-value source and the original design omitted it.** It is the
only artefact that states what must pass before a change merges, and roughly half
of all detectable command drift is invisible without parsing it. The other
derivation sources describe what *exists*; CI describes what is *enforced*.

### Altitude 1 — module map (orientation)

Every `Module` in the repo, with `DEPENDS_ON` edges between them. Small enough
(target 10–25) to render whole — this is the orientation layer, so it is never
filtered by target.

`Module` and `DEPENDS_ON` already exist in the schema and are unpopulated. This
work populates them:

- **Nodes:** Louvain community detection over the `IMPORTS` graph, run
  server-side. Communities find real coupling seams, which frequently cut across
  the directory layout and expose structure folders hide.
- **Edges:** `DEPENDS_ON`, rolled up from file-level `IMPORTS` between members.
- **Entry point:** each `Module` records its highest-centrality member file, so
  every module offers a concrete "front door" to open rather than an abstract box.

Louvain is non-deterministic across runs. Use a fixed seed and cache results;
switch to Leiden if cluster stability becomes a complaint.

### Altitude 2 — file closure (first commit)

Files only, filtered to the transitive prerequisite closure of a selected target
(a module, file, or ticket). Everything outside the closure is not rendered.

Closure filtering is what keeps this view from becoming the wall of nodes that
makes the Technical tree unhelpful to newcomers. It also keeps realistic node
counts under ~200.

**Renderer note, corrected.** An earlier draft of this document cited the 500-node
threshold in `apps/web/app/lib/scaleGraph.ts`. That module's
`rendererForVisibleNodeCount()` has **zero production callers** — its only callers
are test files. The live path is `apps/web/app/workspace/rendererRegistry.ts:36`
`rendererFor()`, called from `WorkspaceShell.tsx:363`, using
`rendererRegistry.ts:31` `minimumNodeCount: 501`. The two disagree: the registry
restricts Sigma to `supports: ['technical', 'onboarding']` while the dead twin
returns Sigma for any view over 500.

Consequently, making the Onboarding view React Flow-only is **an edit to
`rendererRegistry.ts`**, not a property that falls out of node counts. Remove
`'onboarding'` from the Sigma entry's `supports` array explicitly.

Default target when none is selected: the highest-centrality module, so the view
is never empty on first load. If a closure exceeds the render cap, truncate and
say so explicitly — "this target touches most of the repo" is useful information,
silent truncation is not.

### Cycles

Import graphs contain cycles, so a prerequisite DAG is not free. Condense each
strongly-connected component with Tarjan's algorithm; a condensation graph is
provably acyclic.

Condensation is a **layout concern, not a graph mutation**. SCC members stay
individual `File` nodes and render as a visually bundled group. Nothing is
written to the graph and no synthetic node label is introduced.

The bundle is a feature, not a workaround: it tells a newcomer *"these files are
mutually entangled, there is no safe reading order, learn them as a unit."* The
Technical tree cannot express that.

### Progress state

Nodes carry `done` / `current` / `locked`. A map is stateless; a path knows where
you are. v1 stores progress client-side per `(user, repo, ref)`. Server-side
persistence is a follow-up, not a prerequisite.

## Onboarding debt

The differential is the product. Alongside what exists, the view renders what is
**missing** — which makes it useful to a team lead auditing onboarding quality,
not only to a new hire reading it once.

This is also the half that survives codebase-aware AI. An assistant answers
questions about what is present; it cannot report an absence, because absence is
not in its retrieval corpus.

### What "documented" has to mean

A naive detector greps all markdown for a name and calls it documented. That is
satisfied by any file that merely mentions the string — **including the debt
report itself**, which makes the detector trivially self-healing and worthless.
An earlier draft of this document hit exactly that failure: it listed undocumented
script names, and by doing so became the only markdown file mentioning them.

A name counts as documented only if it appears:

- inside a fenced code block, **or** under a `Commands` / `Usage` / `Setup`-style
  heading, **and**
- in a human-facing document — not in `.claude/**`, not in a dependency ledger, not
  in a changelog entry, **and**
- not solely in the generated debt report.

Placement, not presence. A command buried at line 183 of a dependency inventory is
not documented in any sense a new hire benefits from.

### Every finding carries a tier, and tiers carry different confidence

Setup failures are mismatches between three things, and only two are in the repo:

| Tier | What it is | Where it lives | Statically decidable |
|---|---|---|---|
| **D — Declared** | manifests, lockfiles, version pins | repo | yes, high precision |
| **N — Narrated** | README, CONTRIBUTING, onboarding docs | repo | yes, but extraction is lossy |
| **H — Host** | installed SDKs, accepted licences, running daemons, drivers, CPU arch, corporate CA | the developer's machine | **no** — requires a probe |

**D↔D and D↔N conflicts are facts. D↔H conflicts are predictions.** Reporting
"you may be missing `libpq-dev`" at the same confidence as "your README says
`npm ci` but the repo has a `pnpm-lock.yaml`" is how a tool gets muted. Tier must
be visible on every finding, and H-tier findings must be phrased as questions.

This also bounds the feature honestly: the highest-cost onboarding failures —
unaccepted Android SDK licences, missing Xcode signing identity, a driver/CUDA
mismatch, a corporate MITM root CA — are H-tier and **structurally invisible** to
repository analysis. We can infer the symptom (an `nvidia/cuda` base image, a
`*-sys` crate, a `find_package(X REQUIRED)` call) and never the truth.

### Detectors — text and manifest

Cheap set differences over files and doc text. Stack-independent.

| Detector | Rule |
|---|---|
| Undocumented command | in a task manifest, not documented per the definition above |
| Command that doesn't exist | `npm run X` in a doc, `X` absent from the manifest at that scope |
| Command that lies | doc's description contradicts what the script body does |
| CI check with no local equivalent | a CI `run:` step reachable by no documented command |
| Undocumented config | env var read in code, absent from every committed example file |
| Stale example config | key in an example file, referenced nowhere in code |
| Unresolvable reference | a doc or comment cites a path that **`.gitignore` guarantees absent** |
| Dangling cross-reference | doc cites a section, branch, or version that does not exist |
| Glossary gap | term used across ≥N files with no defining sentence anywhere |
| Orphaned high-value doc | nested `README` not linked from the root doc or any index |
| README path drift | fenced directory listing whose paths don't resolve |

**Unresolvable reference deserves emphasis.** A reference to a gitignored path is
strictly stronger than a broken link, because cloning cannot fix it. Rationale
pointers into a scratch directory are permanently dead for everyone but their
author.

### Detectors — graph and history

These need the parsed graph, and they are the ones no competitor computes and no
chatbot can answer.

| Detector | Rule |
|---|---|
| **Test-only twin** | a symbol whose only inbound `CALLS`/`IMPORTS` edges come from test files, where a same-named sibling has real callers |
| Orphan file | zero inbound `IMPORTS`, not a framework entry point, ranked by line count |
| Mock in production | `mock`/`fake`/`stub`-named symbol or folder reachable from a production entry point |
| Structural duplicate | types with ≥0.8 property-name overlap across packages with no `IMPORTS` edge between them |
| Rename without doc update | commit message contains a rename verb, touches no `.md`, old term survives in doc text |
| Ungoverned module | `Module` with no governing rule file and no `agent_skill_md` |
| Unowned hotspot | high churn, no `primary_owner_*` |
| Knowledge concentration | rank files by `churn × 1 / distinct(author)`; flag single-author files above a churn threshold |

### The two that are structurally safe

Competitive research found no vendor addressing either. Both are safe from
displacement for the same underlying reason: **they require completeness over the
whole graph, where retrieval requires relevance to a query.**

**Absence.** "Which parts of this system have nothing explaining them." A retriever
cannot express a null result — top-k always returns k things, so a query about an
undocumented module returns the nearest chunk with full confidence. Absence is a
property of the *corpus*, computable only by enumerating nodes and checking coverage
against them. That enumeration is exactly what `Folder`/`File`/`Module` + `CONTAINS`
gives for free. CodeScene detects absence on a different axis (who knows), and is the
nearest thing to a competitor; nobody reports *what was never written down*.

**Liveness.** The test-only twin generalises to a reachability score: inbound call
sites, import count, and git recency give a liveness signal an embedding index cannot
compute at any budget. This is the failure mode retrieval makes *worse* — a
well-named, well-tested, uncalled implementation ranks higher than the live one
precisely because it looks more canonical. This document cited a dead implementation
before the detector was specified.

Two cautions. Meta's context work found deprecated identifiers that **must** stay for
backward compatibility, where naive analysis says "dead, delete" and is
catastrophically wrong — so **liveness is a signal, never a verdict**. And the
magnitude is unmeasured: the mechanism is well-attested in general RAG literature but
nobody has quantified how often it bites in codebases. Measuring it ourselves would be
novel.

### Output shape

**A ranked queue with an owner attached, never a dashboard.** Scorecards degrade into
unopened dashboards without a named owner — the documented failure mode of Backstage
scorecards. Every finding must route to a person and be dismissible.

### Ownership, and the framing rule

`OWNS: Person->File` is declared in `schema.md:75`. Aggregating
`Person -[:AUTHORED]-> Commit -[:MODIFIED]-> File` to the folder level answers "who do
I ask" from data already ingested. Research says this is a top-three onboarding
blocker, and nobody points authorship *downward* at the newcomer at the moment of
confusion — CodeScene has the same data model and sells it upward as a management
risk report.

**Surface risk at the module level, never the person level.** "This directory has no
current maintainer," not "Sarah is your bus factor." Practitioner research on
bus-factor metrics found engineers read person-level scores as surveillance and
managers as political hazard: key engineers feel irreplaceable, others feel unvalued,
and some are discouraged from the project entirely. Person-level framing is why these
dashboards get admired once and never reopened. CodeScene's Knowledge Loss framing —
a property of *code*, not people — is almost certainly why it survived commercially.
Same computation, different political payload.

Two accuracy caveats. Truck-factor work (Avelino et al., 133 projects) found 84% of
respondents agreed the identified people were genuinely main contributors but only
53% endorsed the computed *number* — so surface names, not scores. And **VCS data
systematically undercounts**: a reviewer who has read every line of a module for
three years registers as knowing nothing. Treat authorship as evidence, not truth,
and prefer "likely knows" over "owns".

## Capture: how human knowledge actually lands

Detection finds gaps. Something has to fill them, and the documentation-rot
literature says voluntary documentation loses to the incentive gradient every time.
Four mechanisms, ordered by leverage.

### 1. Harvest before asking

Most of the missing rationale **has already been written** — in PR review comments,
incident threads, and closed issues — just unattached to code and therefore
unfindable. The graph's unique capability here is **localisation**: it knows which
diff hunk a review comment sat on, so it knows which symbol that comment explains.

For each node, mine the PR conversations and linked tickets that touched it,
surface them as *"what people have said about this file"* with author, date, and a
link to the original thread.

Zero capture cost, no incentive problem, and it is prose written by a named human
at a known time — which sidesteps the generated-content trust problem entirely.
This is promotion of existing evidence, not manufacture of explanation. **Ship this
before any prompting mechanism.**

### 2. Mine the newcomer's confusion

The curse of knowledge means experts cannot report what is confusing; the newcomer
can and does not know it. Microsoft's finding that recently-onboarded engineers make
the most effective onboarders is direct support.

Instrument which nodes new hires revisit, what they search for and fail to find, and
where they backtrack. Aggregate. The prompt to the expert then stops being a blank
page and becomes a specific, answerable, socially motivating request:

> Four of the last five new engineers spent 40+ minutes in `reconcile.py`, then asked
> in chat. One sentence — what should they have known?

That converts documentation from an act of imagination into an act of recall.

### 3. Ask in the pull request, rarely

The moment of authorship is maximum knowledge and minimum answering cost. But the
bot literature is unambiguous: bot volume is the primary driver of longer PR
resolution times, and as bots comment more, relevance declines. **Muted is
terminal.**

Trigger only on the conjunction: the node is high-centrality, **and** has no attached
rationale, **and** has not been modified in months, **and** newcomers have measurably
struggled with it. Then add one pre-filled field to the PR body — not a comment
thread, which is where bots go to die.

**Ask-rate is a first-class product metric with a hard ceiling.** Budget roughly one
prompt per engineer per week and alert on breach.

### 4. Use forcing events

Organisations fund knowledge capture at exactly three moments. Ride them rather than
fighting the gradient:

- **Departure.** When a top author gives notice, the concentration detector yields a
  ranked, time-boxed list of what only they understand. Exit interviews are already
  funded and currently unguided.
- **Post-incident.** The postmortem is a mandated writing exercise that already
  happens. Attach its findings to the nodes involved — the deploy SHA gives you the
  wiring for free.
- **Onboarding itself.** Make the new hire's first PR a fix to whatever blocked them.
  The only self-healing loop available, because the person with the beginner's eye
  writes it and the expert who couldn't have written it reviews it.

### Storage rules

Capture reuses `agent_skill_md` — already per-node, version-controlled with immutable
history and `expectedVersion` conflict handling, already rendered.

**This requires a contract change.** `docs/agent-skill-md.md` mandates exactly three
level-two headings and rejects any additional one. Add a fourth, optional:

```md
## Onboarding Notes
```

Ship the validator change **before** any writer emits the new section, or valid
documents will be rejected. Existing three-section documents stay valid.

Two rules follow from the rot literature:

- **Never edit a captured note; supersede it.** Immutability is why ADRs survive where
  wikis don't — it removes the maintenance obligation entirely and preserves history.
- **Decay must be visible, never silent.** Show "written 2 years and 340 commits ago;
  the function it describes has changed twice since." Trust collapse comes from stale
  content presented as current. Content presented *with* its staleness stays usable.

## The agent surface

The same detectors are worth more to a coding agent than to the canvas, and the
gateway to expose them already exists (`docs/mcp-gateway.md`). This matters for
sequencing: **the MCP surface has no dependency on the view**, so it can ship,
be measured, and produce an attributable number before any visualisation work
lands — which inverts the order that CodeScene's surviving competitors and
CodeSee's dead one both got wrong.

Tool slots are scarce; agents degrade with long tool lists. Each addition has to
beat "the agent could just grep for this," which disqualifies `explain_file`,
`search_code`, and `summarize_module`.

| Tool | Status | Why an agent cannot do this itself |
|---|---|---|
| `check_liveness(node_id)` | **shipped** | Retrieval ranks the dead twin *above* the live one — it is better named, better commented, better tested. Reachability is a graph property. |
| `traverse_from(node_id, intent: "prerequisites")` | extend existing | Transitive reversed-`IMPORTS` closure with SCC condensation. Not greppable. |
| `get_orientation(node_id)` | proposed | Meta's compass format, generated rather than hand-written — they needed a 50-agent swarm and 10 critic passes to build 59 by hand. |
| `find_undocumented(scope, limit)` | proposed | Absence. A retriever cannot return a null result; top-k always returns k. |

`find_undocumented` introduces one RBAC subtlety the node-scoped tools avoid.
Every existing tool returns `null` for hidden and absent alike, so the two stay
indistinguishable. A scope-level query enumerates, so **counts must be computed
after filtering** — otherwise `totalUndocumented` leaks the existence of nodes
the caller cannot read. Same class as the module-label leak above.

### Attribution, which the human metric can no longer provide

`mcp_context_tokens_served` and `mcp_tool_call_count` are already recorded per
key, per tool, per outcome. That is the mechanical, instantly-attributable
measure that time-to-Nth-PR cannot be: run the same task with and without the
server and compare tool calls and tokens. Meta measured 40% fewer tool calls
from equivalent context. This is the one place in the design where impact is
provable in an afternoon rather than argued over at renewal.

## Explicitly not building

**Generated architectural narrative.** Do not auto-generate prose explaining why the
system is the way it is. It is the most demo-able feature here and the most likely to
kill the product: it manufactures confident explanation of exactly the rationale that
is provably absent from the inputs. One wrong "this service was designed this way
because…" and trust collapse takes the whole surface down.

Generate **questions**, not answers. Always attribute the human who supplied an
answer, and when.

## Required changes to standing rules

Both are deliberate amendments, not oversights.

1. **`Module` becomes drawable.** `schema.md:34-38`, `.claude/rules/graph-schema.md`,
   and `CLAUDE.md` currently state only `Folder` and `File` render on canvas. The
   `Function`/`Class` prohibition stays — those would explode node counts with no
   onboarding value. This narrows the rule to its actual intent rather than
   deleting it.
2. **`Module` gains properties.** Beyond `name`: generated label, centrality
   score, and representative file id. Per `.claude/rules/graph-schema.md`, this
   requires updating `schema.md` in the same PR.

## RBAC and caching

Community detection runs server-side in the Graph Query Service, consistent with
`.claude/rules/security-multitenancy.md`. Client-side graphology stays limited to
layout and local filtering.

Clustering is computed **once per `revisionSha` on the full graph**, then filtered
per request. One cache entry per revision; communities stay stable across users.

Three consequences that must be handled explicitly:

- A module with no authorized members is removed entirely, not shown empty.
- **Module labels are generated only from files the requesting user can read.**
  A label derived from hidden files would leak the existence of hidden structure —
  a module named "billing" reveals billing exists even with every file hidden.
- **Harvested PR comments and captured notes inherit the RBAC scope of the node they
  attach to.** A comment quoting a hidden file's contents must not surface through an
  authorized neighbour.

## Scope

**In, v1:** derived ground-rules panel including CI parsing; `Module`/`DEPENDS_ON`
population via Louvain; module map; target-closure file view; SCC bundling; layered
layout via dagre; progress state (client-side); the text and manifest detectors; the
graph and history detectors; PR-comment harvesting; `Onboarding Notes` section with
immutability and visible decay.

**Out, v1:** server-persisted progress; newcomer-confusion instrumentation (needs the
view shipped first to have anything to instrument); PR-authorship prompting; Leiden;
cross-repo onboarding; cyclomatic complexity and LOC.

**Wanted, blocked on other work:** ownership is on `File` in the graph but not in the
canvas payload — plumbing, not enrichment, and worth doing early since "who do I ask"
is a top-three onboarding question.

## Risks

| Risk | Mitigation |
|---|---|
| Most pain is human-only, so the graph addresses a minority of it | Accepted and designed for — the graph routes and attaches; capture mechanisms carry the rest. Do not re-weight toward visualisation. |
| Generated module labels are poor | Weakest link in the design. Human-editable override from day one. |
| Detector false positives erode trust | Trust collapse is binary. Ship only high-precision rules; make each dismissible; prefer missing a gap to reporting a false one. |
| Prompt fatigue gets the product muted | Hard ask-rate ceiling, monitored. Harvest before prompting. |
| Louvain instability across runs | Fixed seed plus per-revision caching; Leiden if it persists. |
| Closure covers most of the repo | Cap and state it plainly rather than truncating silently. |
| Amending a non-negotiable rule sets precedent | Narrow the rule to its intent, document the rationale in the PR per the closed-set policy. |
| **Node-link layout is illegible above a few hundred nodes** | Confirmed, not a design failure — the cognitive-load research tested 25–175 nodes and treated 175 as a ceiling worth studying. **The default view must never be "the whole repo."** Closure filtering is therefore load-bearing, not an optimisation. |
| **The codebases that most need explaining are the ones static graphs explain worst** | Unmitigated, and the central tension. Legacy systems are where the pain is fundable, and they are disproportionately dynamic (DI, reflection, autoloading), config-wired, or structureless. A static import graph of a Spring or Rails app is *confidently wrong* — it shows modules as disconnected when they are coupled at runtime, which teaches a false mental model. Prefer omission to a wrong edge; consider runtime-trace ingestion before widening static inference. |
| **Polyrepo: the pain is highest where a single-repo tool cannot reach** | Unmitigated in v1 and a genuine strategic gap. "Which of these 40 repos does this feature touch" is unanswerable from inside any one of them. Cross-repo ingestion is the differentiated product and is out of v1 scope — flag before committing to a single-repo architecture that forecloses it. |
| **Impact cannot be attributed** | Time-to-10th-PR fell from ~86–91 days to 33–49 days industry-wide because of AI assistants, not onboarding tools (DX, n≈400 companies). Any improvement lands inside a metric already moving 40%+/yr from an unrelated cause. Do not build the business case on human ramp-up. Prefer mechanical, instantly attributable measures. |
| **There is no onboarding budget to sell into** | Every comparable migrated to a pre-existing budget line. Position this feature as an outcome of a platform, code-quality, modernisation, or key-person-risk purchase — never as an "onboarding" line item. |
| **The tool has the adoption problem it is studying** | A checker nobody must run gets run once, by a newcomer, on the day its findings are already stale. The only durable fix is to attach it to a high-frequency existing workflow. For this product that means **CI**: deterministic, diffable output and a meaningful exit code, so a README that drifts from `package.json` breaks the build and the check stays honest because people with working machines depend on it. |

# Stage — `pr-review`

Reviews an open pull request. Runs **after** a PR exists, outside the per-ticket
`planner → red → dev → tester → review → security` sequence. Invoked on demand as
`/pr-review <PR#>`; it is an accelerator and a backstop, never a replacement for a human reviewer.

Reviews **any** PR, not only fenced contributors' — bounds simply reports "no constraint" for an
unfenced author.

## Required inputs

1. The PR diff and metadata (`gh pr view`, `gh pr diff`).
2. The linked ticket, for its declared **lane**. Planner (`.sdd/stages/planner.md`) already reads
   this from the ticket once and records it verbatim in `spec.json`'s `lane` field (PL-03e) — prefer
   that canonical value, from `.pipeline/spec.json` if this run's working files are still on disk, or
   from its durable copy at `.sdd/ledger/<run-id>/spec.json` once a ledger entry exists for this
   ticket, over re-parsing the ticket body yourself. Fall back to reading the linked ticket/issue
   directly only when neither copy of `spec.json` is available. If the PR links no ticket, or no
   lane is declared anywhere, say so and treat bounds as unverified — do not infer a lane from the
   diff. Inferring a lane from the change is circular: it would derive the constraint from the thing
   being checked.
3. `.sdd/ledger/index.json` where relevant — to find the spec that produced a file the PR touches.

## The bounds verdict is computed, not judged

Run:

```
node scripts/check-bounds.mjs --lane <lane> --base <base-branch> --json
```

Exit `0` = in bounds, `1` = violation(s), `2` = the check could not run. **Report what the script
returned. Do not form your own opinion about whether a path is in the lane** — an agent asked "did
this stay in bounds?" can hallucinate a pass; a glob match cannot. Your judgment applies only to
whether an out-of-lane change was *justified*, which is a different question and genuinely yours.

If the script exits `2`, bounds are **unverified**, not clean. Say that explicitly.

## Lenses

Report each separately. A single blended verdict hides which dimension failed, and D-005 #2 records
that specialized critics catch what one averaged prompt misses.

1. **Bounds** — the script's verdict verbatim, plus your adjudication of any out-of-lane path:
   was it justified in `changes.md`, and is the justification adequate?
2. **Red-test integrity** — `.pipeline/red.json` is gitignored, per-run scratch: it will not exist
   on a fresh checkout of the PR branch, since `.pipeline/` never gets pushed. Do not run
   `node scripts/check-red-integrity.mjs` against `.pipeline/` unconditionally and report whatever
   it says as this lens's result — its "no red.json for this run" status means *nothing was
   checked*, and reporting that as a clean lens is worse than no lens at all (a check that always
   passes teaches a reader nothing). Instead:
   1. If `.pipeline/red.json` exists (rare once a PR exists, but possible if you're running in the
      same working tree the pipeline just ran in, before it was pushed), run
      `node scripts/check-red-integrity.mjs` plain.
   2. Otherwise, use the same ledger lookup as the `lane` field above to find this ticket's run
      directory. If `.sdd/ledger/<run-id>/red.json` exists there (copied verbatim by
      `ledger-append.mjs` whenever `red` ran and the run reached terminal `PASS`), run
      `node scripts/check-red-integrity.mjs --dir .sdd/ledger/<run-id>` — the ledger directory holds
      the same `red.json`/`spec.json`/`changes.json` shape `.pipeline/` does, so the script's
      mechanical rehash/`@spec`-resolution logic is unchanged; only the source directory differs.
   3. If neither location has a `red.json` (the ticket predates `red`, or no run has reached
      terminal `PASS` yet), report this lens under **Unverified**, not as clean — say plainly that
      red-test integrity could not be checked and why.

   Whichever source resolved: report it. A red test whose content changed without a declaration in
   `changes.json`'s `redTestChanges` is a finding. The mechanical half (rehash, `@spec` resolution)
   is the script's; the judgment half — is the declared reason legitimate — is yours.
3. **Spec conformance** — does the diff deliver the ticket's goal, and only that? Scope creep in a
   PR that otherwise passes is still a finding.
4. **Test adequacy** — did the affected tests actually run? Were regressions addressed rather than
   absorbed? A skipped test looks identical to a passing one; if coverage was skipped, say so.
5. **Architecture rules** — the three `CLAUDE.md` "Don't"s (no Function/Class nodes on canvas, no
   Graph DB access from a route handler, no new queue system for an integration) plus any
   applicable `.claude/rules/`. Note honestly that a reviewing agent is weaker here than a static
   rule would be; D-018 #2's Semgrep recommendation remains the real answer.
6. **Limitations** — what the author did *not* do. Read the PR template's "Additional info /
   limitations" section; if it is empty on a non-trivial PR, that itself is worth flagging.
7. **Security surface** — does this touch `org_id` handling, RBAC filtering, secrets, webhook
   validation, or the Graph Query Service? If yes and no security verdict accompanies the PR, say
   so. This lens routes; it does not replace the `security` stage.

## Output

Write `.pipeline/pr-review.md`:

- **Verdict** — exactly one `## Verdict` heading, containing exactly `APPROVE`, `COMMENT`, or
  `REQUEST_CHANGES`.
- **Per-lens findings**, each with file/line and a concrete suggested action.
- **Unverified** — every lens you could not complete, and why. An unrun check must never be
  silently absent from the report; absence of a finding is not evidence of absence.

**Posting to the PR is opt-in.** By default write the file locally and stop. Post only when
explicitly invoked with a posting flag — an agent that comments on PRs by default will eventually
comment on something the author would rather it had not.

## Read-only

You do not edit source code. Since PL-03g this is enforced at the runtime boundary by
`scripts/guard-checker-readonly.mjs`, wired as a `PreToolUse` hook in `.claude/settings.json` —
add `pr-review` to that script's `READ_ONLY_AGENTS` set when this stage is registered, or the
enforcement will silently not apply to it.

Note the honest limit: the guard covers `Write`, `Edit`, and `NotebookEdit`. It does not cover
`Bash`, because a command-allowlist approach was tried and rejected on the merits — a single
allowed command that executes project code (`poetry run pytest` running `conftest.py`) makes
command-layer default-deny meaningless. So the read-only property holds against the tools you
would normally reach for, and not against `Bash`. Do not use `Bash` to write.

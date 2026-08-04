# .pipeline

Shared working folder for the Planner -> Red -> Dev -> Tester -> Review -> Security pipeline. Run the whole thing with `/pipeline <ticket>`. Each stage reads the prior stage's file and writes its own:

| File | Written by | Read by |
|---|---|---|
| `spec.md` | planner (Opus) | red, dev |
| `red.md` | red (Opus) | dev, tester, review, ledger-append.mjs |
| `changes.md` | dev (Sonnet) | tester, review, security-checker |
| `test-results.md` | tester | review |
| `review.md` | review (read-only) | security-checker, dev (if `NEEDS_FIXES`), humans |
| `security-report.md` | security-checker (read-only) | dev (if `BLOCKED`), humans, ledger-append.mjs |
| `security-history/<run-id>/manifest.json` | security-checker (read-only) | later security runs, humans, artifact exporter, ledger-append.mjs |
| `security-history/<run-id>/results.json` | security-checker (read-only) | later security runs, humans, progress tooling, ledger-append.mjs |
| `security-history/<run-id>/report.md` | security-checker (read-only) | later security runs, humans |

**Routing:** if `review.md`'s verdict is `NEEDS_FIXES`, the pipeline goes back to `dev`, which reads `review.md`'s fix list before re-implementing (`red` does not re-run). Same pattern if `security-report.md` comes back `BLOCKED`. `review` and `security-checker` do not edit source code — this is **convention, verified at review, not enforced**. A `PreToolUse` hook declared in subagent frontmatter was previously believed to enforce it; a 2026-07-31 diagnostic showed frontmatter-declared hooks do not fire (settings-file hooks do). Real enforcement is tracked as PL-03g.

**Red-test integrity / spec trace (PL-03c):** `review` runs `node scripts/check-red-integrity.mjs` (`npm run check:red-integrity`) as the mechanical half of its Red-test integrity and Spec trace checks — it rehashes every file `red.md` lists and resolves every `@spec` marker against `spec.md`, exiting non-zero on an undeclared hash mismatch or an unresolvable ID. `review` still makes the judgment calls the script can't: whether a declared reason is legitimate, and whether a marker-less new test the script surfaces is actually behavioral.

**Terminal `PASS` (PL-03c):** once `review.md` and `security-report.md` both show `PASS`, `node scripts/ledger-append.mjs` writes a durable, tracked entry — `.sdd/ledger/<run-id>/{spec.md,entry.md,security/}`, reusing the security run's own id — and regenerates `.sdd/ledger/index.json`. `security/` (round 3) is a **copy**, never a move, of this same run's `security-history/<run-id>/{manifest.json,results.json,report.md}` below — copy, because that source directory stays right where it is (immutable, and read by later runs as their own progress baseline; see below), and copy rather than reference because a `.pipeline/` wipe must not take the audit record with it. That is the thing this ticket promotes out of `.pipeline/`'s ephemerality; see `.sdd/ledger/README.md`.

The six top-level stage files (`spec.md`, `red.md`, `changes.md`, `test-results.md`, `review.md`, `security-report.md`) are per-ticket working state and may be overwritten. Security history directories are immutable and must never be reused or overwritten; later runs use them as progress baselines, and `ledger-append.mjs`'s own copy into `.sdd/ledger/<run-id>/security/` reads from them without ever moving or deleting them. Everything under `.pipeline/` except this README is gitignored because audit evidence may contain sensitive paths or sanitized attack traces. Export completed `security-history/<run-id>/` directories to an approved access-controlled CI or security-artifact store before deleting a worktree or when history must survive machines — the `.sdd/ledger/<run-id>/security/` copy is the durable, committed record for every run that reached terminal `PASS`, but a run that never reaches `PASS` still relies on this export step, since no ledger entry (and so no `security/` copy) is ever written for it.

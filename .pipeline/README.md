# .pipeline

Shared working folder for the Planner -> Dev -> Tester -> Review -> Security pipeline. Run the whole thing with `/pipeline <ticket>`. Each stage reads the prior stage's file and writes its own:

| File | Written by | Read by |
|---|---|---|
| `spec.md` | planner (Opus) | dev |
| `changes.md` | dev (Sonnet) | tester, review, security-checker |
| `test-results.md` | tester | review |
| `review.md` | review (read-only) | security-checker, dev (if `NEEDS_FIXES`), humans |
| `security-report.md` | security-checker (read-only) | dev (if `BLOCKED`), humans |
| `security-history/<run-id>/manifest.json` | security-checker (read-only) | later security runs, humans, artifact exporter |
| `security-history/<run-id>/results.json` | security-checker (read-only) | later security runs, humans, progress tooling |
| `security-history/<run-id>/report.md` | security-checker (read-only) | later security runs, humans |

**Routing:** if `review.md`'s verdict is `NEEDS_FIXES`, the pipeline goes back to `dev`, which reads `review.md`'s fix list before re-implementing. Same pattern if `security-report.md` comes back `BLOCKED`. `review` and `security-checker` do not edit source code — this is **convention, verified at review, not enforced**. A `PreToolUse` hook declared in subagent frontmatter was previously believed to enforce it; a 2026-07-31 diagnostic showed frontmatter-declared hooks do not fire (settings-file hooks do). Real enforcement is tracked as PL-03g.

The five top-level stage files are per-ticket working state and may be overwritten. Security history directories are immutable and must never be reused or overwritten; later runs use them as progress baselines. Everything under `.pipeline/` except this README is gitignored because audit evidence may contain sensitive paths or sanitized attack traces. Export completed `security-history/<run-id>/` directories to an approved access-controlled CI or security-artifact store before deleting a worktree or when history must survive machines.

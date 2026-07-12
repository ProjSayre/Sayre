# ./pipeline

Shared working folder for the Planner -> Dev -> Tester -> Review -> Security pipeline. Run the whole thing with `/pipeline <ticket>`. Each stage reads the prior stage's file and writes its own:

| File | Written by | Read by |
|---|---|---|
| `spec.md` | planner (Opus) | dev |
| `changes.md` | dev (Sonnet) | tester, review, security-checker |
| `test-results.md` | tester | review |
| `review.md` | review (read-only) | security-checker, dev (if `NEEDS_FIXES`), humans |
| `security-report.md` | security-checker (read-only) | dev (if `BLOCKED`), humans |

**Routing:** if `review.md`'s verdict is `NEEDS_FIXES`, the pipeline goes back to `dev`, which reads `review.md`'s fix list before re-implementing. Same pattern if `security-report.md` comes back `BLOCKED`. `review` and `security-checker` cannot edit source code themselves — enforced by a hook (`scripts/validate-pipeline-only-write.sh`) that blocks any `Write`/`Edit` outside this folder for those two agents.

These files are per-ticket working state, not permanent documentation — they're gitignored by default (see root `.gitignore`). Copy them out before starting the next ticket if you want a record of a given run, since each stage overwrites its file every time.

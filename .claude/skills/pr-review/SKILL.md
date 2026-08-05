---
name: pr-review
description: Reviews an open pull request across seven lenses, with the lane-bounds verdict computed by a script rather than judged. Invoke explicitly with /pr-review <PR#>. Never auto-triggers — it reads a real PR, runs checks, and can optionally post a comment.
disable-model-invocation: true
argument-hint: <PR number> [--post]
---

Review pull request: $ARGUMENTS

Follow `.sdd/stages/pr-review.md` exactly — it is the authoritative, runtime-neutral definition of
this stage. Invoke the `pr-review` subagent.

Two things this command must not do, restated here because they are the ones most easily lost:

- **The bounds verdict comes from `node scripts/check-bounds.mjs`, not from judgment.** Report what
  the script returned. Exit `2` means bounds are *unverified*, not clean.
- **Do not post to the PR unless `--post` was passed.** Default is to write `.pipeline/pr-review.md`
  locally and stop.

If the PR links no ticket, or the ticket declares no lane, report bounds as unverified rather than
inferring a lane from the diff — inferring the constraint from the thing being checked is circular.

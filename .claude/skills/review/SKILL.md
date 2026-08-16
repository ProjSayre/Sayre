---
name: review
description: Runs just the review stage against the current .pipeline/spec.md, changes.md, test-results.md, and red.md, and reports PASS or NEEDS_FIXES. Use to (re)run review on its own, without running the rest of the pipeline.
disable-model-invocation: true
argument-hint: (no arguments)
---

Run only the review stage.

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/review.md` (the authoritative definition of this command). Invoke the `review`
subagent; it writes `.pipeline/review.md`/`review.json` directly (confined to `.pipeline/` by the
read-only guard — see `.sdd/runtimes.yml`). Require `.pipeline/spec.md`, `.pipeline/changes.md`,
and `.pipeline/test-results.md` to exist first — if any is missing, say which stage needs to run
instead of improvising. Do not continue to `security-checker` — this command stops after review, on
purpose. If the verdict is `NEEDS_FIXES`, say so clearly so the caller knows to re-invoke `/dev`
rather than `/security`.

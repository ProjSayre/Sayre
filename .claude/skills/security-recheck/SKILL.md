---
name: security-recheck
description: Alias of /security --mode REMEDIATION_RECHECK — re-runs just the security-checker stage for a fast check after a hand-edit made outside the pipeline, without re-running tester or review. Kept working under this name so existing habits don't break; use /security for the same behavior under its canonical name.
disable-model-invocation: true
argument-hint: (no arguments)
---

Re-run only the security stage against whatever is currently on disk.

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/security-recheck.md` — it is a thin alias of `/security --mode
REMEDIATION_RECHECK`, deferring to `.sdd/entrypoints/security.md` (see that file), kept working
under this name so existing habits don't break. Invoke the `security-checker` subagent with mode
`REMEDIATION_RECHECK`; it writes `.pipeline/security-report.md` directly (see `.sdd/runtimes.yml`).
This command deliberately does not re-run `tester` or `review`.

Note: if there is no completed `dev`/`tester`/`review` run behind the hand-edit at all — no
`review.json` on disk — this is not the right command; use `/pipeline` instead. If a hand-edit was
made to a tree that already has a `review.json` and you want tester and review re-verified too, not
just security, use `/re-gate` instead of this command.

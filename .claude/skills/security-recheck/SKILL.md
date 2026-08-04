---
name: security-recheck
description: Re-runs just the security-checker stage, for when you've hand-edited code after the pipeline finished and want a fast re-check without re-running tester or review.
disable-model-invocation: true
argument-hint: (no arguments)
---

Re-run only the security stage against whatever is currently on disk.

Follow `.sdd/pipeline.md`'s "`/security-recheck`" section exactly — it is the authoritative,
runtime-neutral definition of this command. Invoke the `security-checker` subagent with mode
`REMEDIATION_RECHECK`; it writes `.pipeline/security-report.md` directly (see
`.sdd/runtimes.yml`). This command deliberately does not re-run `tester` or `review`.

---
name: security-recheck
description: Re-runs just the security-checker stage, for when you've hand-edited code after the pipeline finished and want a fast re-check without re-running tester or review.
disable-model-invocation: true
argument-hint: (no arguments)
---

Re-run only the security stage against whatever is currently on disk.

1. Check that `.pipeline/spec.md` and `.pipeline/changes.md` exist. If either is missing, tell the user the full pipeline hasn't run yet and this command has nothing to check against — suggest `/pipeline` instead.
2. Invoke the `security-checker` subagent with audit mode `REMEDIATION_RECHECK`. It runs its own `git diff`, so it will catch any hand-edits made after the pipeline finished even though `changes.md` won't mention them. Tell it which prior finding IDs or remediation references prompted the recheck when that context is available; never tell it to skip sibling or bypass paths.
3. `security-checker`'s own instructions require `review.md` to show `PASS` before it runs a full check. If `review.md` is missing or shows `NEEDS_FIXES`, let it stop and report that, rather than forcing it through — a hand-edit made after a failed review isn't a safe thing to security-clear in isolation.
4. Report the resulting `.pipeline/security-report.md` verdict (`PASS` / `BLOCKED`) back to the user, along with the immutable run ID, baseline run ID, finding transitions, coverage losses/gains, and any remaining findings. If `BLOCKED`, note that fixes should go through `dev` and this command should be re-run afterward — don't re-run tester/review automatically, since that's a deliberate scope limit of this command (fast recheck, not full pipeline).

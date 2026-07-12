---
name: spec-only
description: Runs just the planner stage for a ticket and stops, writing ./pipeline/spec.md for human review before dev touches any code. Use when you want to check or hand-edit a spec before the rest of the pipeline runs.
disable-model-invocation: true
argument-hint: <ticket description or path to ticket file>
---

Run only the planning stage for: $ARGUMENTS

1. If `./pipeline/spec.md` already exists, tell the user it will be overwritten and ask for confirmation before continuing.
2. Invoke the `planner` subagent with the ticket/feature request above. It reads the PRD and writes `./pipeline/spec.md`.
3. Do NOT continue to `dev`, `tester`, `review`, or `security-checker` — this command stops after planning, on purpose.
4. Report back to the user:
   - The Goal, Scope, and Open Questions sections from spec.md (so they don't have to open the file to know if it's worth reading closely)
   - Where the file lives (`./pipeline/spec.md`)
   - That they can hand-edit it directly before continuing
   - How to continue afterward: **invoke the `dev` subagent directly** (e.g. "Use the dev subagent to implement this") rather than running `/pipeline` — `/pipeline` always starts from `planner` and would regenerate (and overwrite) the spec you just reviewed/edited.

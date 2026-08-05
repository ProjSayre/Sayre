---
name: re-gate
description: Re-verifies a hand edit. V2 runs resume through their state machine; legacy v1 artifacts use the disclosed ledger re-gate path.
disable-model-invocation: true
argument-hint: [--ticket <id>]
---

Follow `.sdd/pipeline.md`.

For an active v2 run, never trust stale verdict files: run `pipeline-run reopen --reason <reason>`,
record the hand edit through `dev`, then run verify, review, and security normally. A finalized v2
run needs a new run. For legacy v1 artifacts only, require the caller's independent
`--ticket` assertion and follow the legacy re-gate/ledger rules in `.sdd/ledger/README.md`; do not
derive the ticket from an artifact being checked.

---
name: security-recheck
description: Re-runs the security decision for a current v2 run after required upstream gates are fresh.
disable-model-invocation: true
argument-hint: (no arguments)
---

Follow `.sdd/pipeline.md`'s recheck rules. Security alone cannot make a stale verify/review artifact
fresh. If state returns `next: security`, invoke `security-checker` in the recorded mode; otherwise
report the required upstream stage and stop.

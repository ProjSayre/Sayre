---
name: hotfix
description: The sanctioned pipeline bypass, for when production is broken and the fix is small and obvious. Skips the pipeline stages but requires a ledger entry recording what was skipped, plus a follow-up ticket. Invoke explicitly with /hotfix <description>.
disable-model-invocation: true
argument-hint: <what is broken>
---

Hotfix: $ARGUMENTS

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) then read
`.sdd/entrypoints/hotfix.md` (the authoritative definition of this command), which itself defers to
`.sdd/hotfix.md` for the full, runtime-neutral procedure.

**Before doing anything, check the four gates in `.sdd/hotfix.md`:**

1. Is production actually broken, and is the fix small and obvious? Urgency, confidence, and a
   deadline are not qualifying conditions — each is the normal path with impatience attached.
2. Is the author on an unfenced (`full`) lane? A fenced contributor may not use this; they escalate
   to someone who can. That is the correct path, not an obstacle.
3. Does the change touch `org_id` handling, RBAC filtering, secrets, webhook validation, or the
   Graph Query Service? If yes, **stop** — those are ineligible. Fix forward through the normal
   path, or roll back.
4. Is rolling back available? It usually is, and it is usually better. Prefer it.

If any gate fails, say so plainly and route to the normal pipeline instead of proceeding.

**After the fix**, both of these are required, not optional:

- `node scripts/ledger-append.mjs --hotfix` — an entry recording what broke, what changed, why the
  pipeline was skipped, and **what was not verified**. That last field is the point: a hotfix is
  defined by the checks it skipped, so a record omitting them is not a record of a hotfix.
- A follow-up ticket, opened before the incident is closed.

A hotfix ledger entry is marked as a bypass and must never be confusable with a run that passed
both gates — a `PASS` entry means the code followed its spec, and a hotfix entry means nothing of
the kind.

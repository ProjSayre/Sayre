# `/hotfix` — the sanctioned bypass

The pipeline is the normal path. This is the abnormal one, and it exists because **the alternative
to a sanctioned bypass is an unsanctioned one.** D-005 #3: with no legitimate escape hatch, the
first 2am incident routes around the pipeline anyway and leaves no record at all. A bypass that is
recorded is strictly better than a bypass that is invisible.

## When this is the right call

Production is broken and the fix is small and obvious. That is the whole list.

**Not** for: a ticket that feels urgent; a change whose author is confident; a fix that is "too
small to need a spec"; a deadline. Every one of those is the normal path with impatience attached,
and D-005 #6's fully-specified-ticket rule applies — completeness is not exemption. A fix that really
is "too small to need a spec" (routine maintenance — a typo, a one-file cleanup, a doc fix), with no
production incident behind it, routes to `/pipeline-lite` instead (`.sdd/pipeline.md`'s
`/pipeline-lite` section) — a proportionate, mechanically-gated lane through the real pipeline, not
this bypass.

If you are unsure whether something qualifies, it does not. The cost of a needless pipeline run is
an hour; the cost of a needless bypass is that the bypass becomes the norm.

## Who may use it

Anyone on an unfenced (`full`) lane.

**Not available to a fenced contributor.** This is the first real consequence of the lane
vocabulary: a fenced lane exists because someone's changes get a human check before they land, and
a bypass that removes the check would make the fence decorative. A fenced contributor facing a
genuine emergency escalates to someone with `full` — that is the correct escalation path, not an
obstacle to route around.

## What it does

Skips `planner`, `red`, `dev`, `tester`, `review`, and `security` as a sequence. You implement
directly.

## What it still requires — non-negotiable

1. **A ledger entry**, written at the time of the fix, recording: what broke, what you changed,
   why the pipeline was skipped, and what you did *not* verify. That last field is the one that
   matters — a hotfix is defined by the checks it skipped, and a record that omits them is not a
   record of a hotfix, it is a record of a normal change wearing the wrong label.
2. **A follow-up ticket**, opened before you close the incident, to bring the change back through
   the normal path or to justify why it does not need to. An unpaid hotfix is technical debt with
   no ticket, which is how it becomes permanent.
3. **The entry is marked as a bypass**, distinguishably from a run that passed both gates. The
   ledger's value is that a `PASS` entry means the code followed its spec; a hotfix entry means
   nothing of the kind, and the two must never be confusable when someone is debugging months
   later and asks the ledger what happened here.

## Honest limits

A hotfix skips the security stage. If the change touches `org_id` handling, RBAC filtering, MCP key
issuance, the async worker fleet, the WebSocket gateway's per-push RBAC re-filtering, secrets,
webhook validation, the core service layer or its routes, or the Graph Query Service, **it is not
eligible for hotfix** — those are precisely the paths where the adversarial pass is load-bearing, and
the blast radius of getting one wrong is not recoverable by a fast follow-up. Fix forward through the
normal path, or roll back.

The exact list is `hotfix_barred_paths` in `.sdd/bounds.yml` — widened by security round
FND-b731f500c5b8 (PL-11) from its original six entries to also cover `services/core/src/services/**`,
`services/core/src/routes/**`, `services/core/src/mcp/**`, `services/workers/**`, and
`services/gateway/**`, after a ~44KB single-line hotfix-shaped change to the service layer was
reproduced measuring as trivially "small." It remains a curated, best-effort list, not a complete
classifier of every security-sensitive path in this codebase.

Rolling back is almost always available and almost always better. Prefer it.

## Wiring

`scripts/ledger-append.mjs --hotfix` writes the bypass entry. It does not require `review.md` or
`security-report.md`, and it stamps the entry so `build-ledger-index.mjs` can distinguish it — a
hotfix entry must never satisfy a query asking which spec governs a file, because no spec does.

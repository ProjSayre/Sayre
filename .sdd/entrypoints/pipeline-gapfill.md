# `/pipeline-gapfill <ticket>`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

The MVP **audit-and-gap-fill** lane for already-shipped Wave 0–4 tickets (see
`docs/product/Audit-Rebuild-Cheat-Sheet.md` and `.sdd/mvp-overlays.yml`). It exists because
`/pipeline` either stops with "already implemented" or rewrites around gaps, and `/pipeline-lite`
is barred from nearly all product code and skips `security`. This lane keeps the full rear gates
(`red` → `dev` → `tester` → `review` → `security`) but **scopes the work to gaps** a dedicated
read-only scout finds first.

**Not `/pipeline`:** greenfield or mostly-missing work escalates out after `gap-scout`.
**Not `/pipeline-lite`:** this lane does not skip `red` or `security`, and is not size-gated by
`lite_eligibility`.
**Not `/re-gate`:** this is a first pass that invents a gap-scoped spec, not a re-verification after
a hand-edit.
**Not `/hotfix`:** production is not broken; a ratified gap-spec is required.

1. **Resolve the ticket id** (`W[0-9]+-[0-9]+`). Look it up in `.sdd/mvp-overlays.yml` via
   `node scripts/extract-ticket.mjs <id> --with-overlays` (never open the full backlog or cheat
   sheet). Absent from YAML → refuse and route to `/pipeline`. Present → use the printed ticket
   slice + overlay framing only.
2. Invoke **gap-scout** (`.sdd/stages/gap-scout.md`) with that extract output. It writes
   `.pipeline/gaps.md` and `.pipeline/gaps.json`.
3. **Branch on `gaps.json.verdict`:**
   - `ALREADY_COMPLETE` — stop. Report the verification. Do **not** run planner/dev, and do **not**
     append a ledger PASS that pretends implementation work ran.
   - `ESCALATE_FULL_PIPELINE` — stop and tell the caller to run `/pipeline <ticket>` (full rebuild).
   - `GAPFILL` — continue.
4. Invoke **planner** in **gap-mode**: prepend the cheat sheet framing; write `spec.md`/`spec.json`
   whose `AC-*`/`EC-*` items map 1:1 onto non-`OK` gaps only. List `OK` gaps under "Out of scope /
   already satisfied" with evidence paths. Do not re-spec the whole feature.
5. Invoke **red** in **gap-mode**: author leading-red tests only for those gap ACs/ECs. Do not
   re-author tests for `OK` items (cite them in gaps evidence instead).
6. Invoke **dev** — implement listed gaps only. Expanding into an `OK` gap without a new `GAP-*` id
   is out of scope.
7. Invoke **tester**, then **review** (unchanged routing / loop cap). Review additionally fails
   `NEEDS_FIXES` if the diff touches paths that cannot be mapped to a non-`OK` gap in `gaps.json`
   (undeclared scope).
8. Invoke **security** — **always** on this lane (including Base-only tickets). MVP polish usually
   lands on lite-barred product paths; skipping `security` here would reopen the hole PL-11 closed.
   Doc-only tickets that are mechanically lite-eligible may use `/pipeline-lite` instead.
9. On terminal `PASS`, run the ledger step with the gapfill marker:
   ```sh
   node scripts/ledger-append.mjs --gapfill
   ```
   which requires a valid stamped `gaps.json` with `verdict: "GAPFILL"`, a non-stale `PASS`
   `review.json`/`security.json` pair, and copies `gaps.json` into the ledger run directory. The
   entry is titled `(GAPFILL)`, carries a `## Gapfill lane` section (overlays, gap counts by
   status, fixed disclosure note), and is indexed into `.sdd/ledger/index.json` like an ordinary
   `PASS`/`PASS` run (disclosure only — gates were not skipped).

Reuse `/pipeline`'s 3-attempt `NEEDS_FIXES`/`BLOCKED` loop back to `dev`. If during the loop the
work grows into a rewrite, stop and escalate to full `/pipeline` rather than stretching gap-mode.

**Honest limits.**

- Gap-scout can still miss a silent narrowing; new red tests for `UNTESTED`/`NARROWED` items are the
  main counterweight, plus review's undeclared-scope check and a full `security` pass.
- `OK` items are not re-proven by new leading-red tests on this lane — they rely on scout evidence.
- Overlay tables in `.sdd/mvp-overlays.yml` can drift from the cheat sheet; when they disagree, the
  YAML wins for mechanical eligibility and the mismatch belongs in Open Questions.
- This lane never skips `security`. It is not a back door for product-code polish without attacker
  briefs.

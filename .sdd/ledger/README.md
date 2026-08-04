# Ledger

> **Scope note (PL-03a):** this is a directory placeholder and entry-format definition only.
> Nothing writes to this directory yet — no stage populates it, and `.sdd/pipeline.md` does not
> reference it. Population is out of scope for this ticket; see `docs/sdd-tdad-design.md`
> ("Institutional memory") for why it exists and what will write to it.

## Why this directory exists

`.pipeline/` is gitignored except for its own `README.md` (see `.gitignore`), so every pipeline run
overwrites the previous run's `spec.md`, `changes.md`, `test-results.md`, `review.md`, and
`security-report.md`. That's intentional for the per-run scratch files — committing them would be
noise and merge conflicts — but it means the repo currently has no record that a run ever happened
once the next run starts.

The ledger is the fix, once something writes to it: one **committed** entry per completed run,
distinct from the gitignored working files it summarizes.

## Entry format (reserved)

When populated, a ledger entry is expected to record, per completed run:

- **Date**
- **Ticket** (title or ID)
- **Spec Goal** (the one-line human-facing outcome from that run's `spec.md`)
- **Files touched**
- **Verdicts** (`review` and `security` final verdicts)
- **Red-test paths** (once the `red` stage exists — PL-03c; not applicable until then)
- **Security run ID** (the `.pipeline/security-history/<run-id>/` directory for that run)

This format is fixed here so downstream tickets (PL-03c, PL-03d) build against a stable shape
rather than inventing their own. It is not implemented by this ticket: no file naming convention,
no writer, and no reader (e.g. a future `pr-review` agent consulting past decisions) exists yet.

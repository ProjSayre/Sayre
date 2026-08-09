# Security Audit Report — PL-13 (secret-access reconcile fix), `/inline-edit` lane, PR_DELTA re-run

**Run ID:** `20260809T073006612Z-010b2fe50c72-PR_DELTA-7ff0f1`
**Verdict:** **PASS**

## 0. Why this run exists

This is a re-run of `20260809T065405029Z-010b2fe50c72-PR_DELTA-877e84` (this run's own baseline), not a fresh audit of a changed diff. `ledger-append --inline` tore at the index-regeneration step while appending 877e84's ledger entry, on a pre-existing, merge-inherited defect: a legacy main-side ledger entry, `.sdd/ledger/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa/`, was committed with `entry.md` but no `entry.json` sidecar (it predates the PL-03h round-4 contract that made `entry.json` the sole authoritative source `build-ledger-index.mjs` reads). The coordinator reconciled this, with review verification at each step:

1. Backfilled `d441aa`'s `entry.json` by hand, per `.sdd/ledger/README.md`'s documented PL-03a one-time migration precedent.
2. Deleted the torn, uncommitted `.sdd/ledger/20260809T065405029Z-010b2fe50c72-PR_DELTA-877e84/` directory (877e84's `.pipeline/security-history/` immutable twin — this run's own baseline material — was untouched).
3. Parked 42 unrelated untracked files (`.playwright-mcp/`, `.pipeline-backup-pl04-20260808/`, untracked `docs/` audits) outside the repo.
4. Regenerated `.sdd/ledger/index.json` (98 files / 4 runs).
5. Re-ran `review` twice more: pass 2 verified the backfill field-for-field; pass 3 verified the cleaned tree, confirmed the PL-13 diff byte-identical (hash `c224667518da584d800ef0926e28d1df73c31307`), and re-stamped fresh (treeHash `32e23774f996688b1b0b7a7cc39819f9ffb9ae76788c2288142d3df4b6864c8e`).

This stage's own no-reuse rule (`.sdd/stages/security.md`'s Required Artifacts section: "refuse to overwrite an existing run") means the run id must be new even though the audited code is unchanged — so 877e84 is retained as immutable baseline material and cited throughout this report, never overwritten.

## 1. Target, mode, milestone, baseline

- **Repository / commit / branch / environment:** identical to 877e84 — `projsayre/sayre`, `010b2fe50c72f0dbbc76fcf71480546e9a5c52a9` on `fix/pl-04-pipeline-defects`, dirty, local-dev-only static analysis (`authorization.runtime_tests_authorized: false`).
- **Mode:** `PR_DELTA`.
- **Gate input:** `.pipeline/review.json` verdict `PASS`, pass 3 (clean-tree re-verification), stamped `treeHash 32e23774…` at HEAD `010b2fe`. Freshness independently re-verified this run: `node scripts/check-stamp-freshness.mjs review.json` → exit `0`, status `"fresh"`.
- **Baseline:** `20260809T065405029Z-010b2fe50c72-PR_DELTA-877e84` — human-specified (the coordinator's own instruction: "877e84 stays as your baseline"), independently verified comparable rather than taken on trust: same commit_sha (literally the same tree state, not merely an ancestor — verified via `git diff HEAD` producing the identical hash both runs recorded), same repository, same environment string, same empty `tenant_fixtures`. 877e84's own `.pipeline/security-history/` directory confirmed still present and unaltered on disk.

## 2. What changed since 877e84, verified independently

**The PL-13 diff itself: byte-identical.** `git diff HEAD -- apps/web/.claude/skills/redteam-ux/driver.mjs scripts/check-secret-access.mjs | git hash-object --stdin` → `c224667518da584d800ef0926e28d1df73c31307` this session — matches review.md pass 3's own re-hash exactly, and matches 877e84's own audited content. Every finding from 877e84 that concerns the diff itself (CORE-03, CORE-06, SEC-01 v1/v2, SEC-02..08/11..14, WEB-01..12, and the persisting SEC-09/SEC-10/SC-* rows) is carried forward as `UNCHANGED`, not re-derived from scratch — re-deriving identical evidence against an identical diff would not produce different conclusions.

**Exactly one new artifact: the `d441aa` backfilled `entry.json`.** Independently examined as its own SEC-10 observation (`v12-ledger-backfill-honesty`, `FIRST_OBSERVATION`, since 877e84 never examined it — see §3) rather than taken on the coordinator's or review's word.

**Tree hygiene: confirmed.** `git status --porcelain` shows exactly three items: the two PL-13 edits plus `?? .sdd/ledger/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa/entry.json`. No `.playwright-mcp/`, `.pipeline-backup-pl04-20260808/`, or untracked `docs/` audit entries remain. `.sdd/ledger/` contains exactly 4 run directories on disk (`bf73ea`, `d441aa`, `728516`, `1bf759`) — no `877e84`.

## 3. The `d441aa` backfill, examined on its own merits

Modeled as a forged-attribution / log-omission-through-an-alternate-path attack on the audit ledger (SEC-10's own scope), not accepted because review already blessed it twice.

- **Field-for-field match:** read `entry.json` and `entry.md` side by side — `runId`, `date` (2026-08-04), `ticket` (W0-00), all 8 `filesTouched` entries in the same order, and `verdicts` (`{review: PASS, security: PASS}`) match byte-for-byte. No field in `entry.json` asserts anything `entry.md` does not already assert.
- **Shape matches the documented precedent:** `entry.json`'s field set (`_comment`, `runId`, `date`, `ticket`, `filesTouched`, `verdicts` — no invented `redTestPaths`/`securityRunId`/`commit`) is identical to `.sdd/ledger/20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea/entry.json`'s own backfill shape, read directly rather than trusted from the README's description of it.
- **Honest provenance:** the `_comment` field discloses who performed the backfill, when, why, and the precedent cited — it does not claim to have been produced by `scripts/ledger-append.mjs`.
- **Independently corroborated, not merely self-consistent:** `.sdd/ledger/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa/security/results.json` (the durable, copied audit-history record) independently shows `status: COMPLETE`, `verdict: PASS`, matching `run_id` — a real security run's own recorded output, not a claim invented by the backfill.
- **One real, narrow, structural property named rather than assumed away:** `build-ledger-index.mjs`'s `readEntryJson` (read directly, lines 171-218) mechanically enforces `runId`-matches-directory-name and the verdicts literal, but does **not** itself re-verify a hand-authored `entry.json`'s claimed verdicts against any `review.json`/`security.json` still on disk for that historical run. Trust for this one-time migration affordance rests on the field-for-field match, the durable `security/` corroboration, and review's own scrutiny — not on a mechanical re-verification this script performs for this specific path. Not exploited here (every corroborating check lines up), but distinct from the ordinary `ledger-append.mjs` path, which does re-verify its own preconditions before writing.
- **Mechanical re-confirmation:** `npm run check:ledger-index` → exit 0, "up to date (98 file(s), 4 run(s))" (independently re-run this session); `index.json` not in `git status` (regenerated bytes match committed); all 8 of `d441aa`'s files resolve to it correctly in `index.json`.

**Result:** `PASS`, `NONE` severity, `FIRST_OBSERVATION` (no comparable 877e84 observation exists for this artifact, which did not exist in that run).

## 4. Findings — unchanged from 877e84

No new, regressed, or resolved findings this run beyond the addition described in §3 (which is `PASS`, not a finding). The same six `OPEN` findings persist, byte-for-byte re-confirmed against the identical diff:

1. **SEC-01 v2** (`FND-b1187a8efdf6`, MEDIUM) — the `check-secret-access.mjs` ALLOWLIST entry for `scripts/guard-checker-readonly.test.mjs` remains a whole-file, permanent, mechanically-unscoped exemption.
2. **SEC-09** (`FND-3043428c5bd1`, LOW) — no ledger actor identity. Now the record shows a THIRD relevant data point in the same direction: this reconciliation itself was performed by a human coordinator hand-editing ledger state directly (the backfill), which is a different but adjacent actor-identity gap — worth noting alongside the two-consecutive-inline-run pattern 877e84 already flagged, though not re-scored (still systemic, still LOW).
3. **SEC-10 v3** (`FND-9ea3ec4bba13`, MEDIUM) — plain ledger-append path's stale spec/ticket agreement.
4. **SEC-10 v6** (`FND-9735a2fbe37a`, MEDIUM) — `--lite` lane's multiplicative size-bound residual.
5. **SC-03** (`FND-d26b84ebd646`, MEDIUM) — no CI dependency/SBOM scanning gate.
6. **SC-06** (`FND-ef0066ad43ed`, LOW) — GitHub Actions pinned to tags, not SHAs.

All six `last_seen_run_id`/`last_seen_commit` updated to this run/commit; none regressed, none resolved.

## 5. Verified clean (re-confirmed this run)

- `node scripts/check-secret-access.mjs` → exit 0 (re-run this session, tree now also contains the ledger backfill — confirmed irrelevant to this gate, which scans tracked source files only).
- `node scripts/check-stamp-freshness.mjs review.json` → exit 0, `"fresh"`.
- `npm run check:ledger-index` → exit 0, "up to date (98 file(s), 4 run(s))".
- `git diff HEAD` over the two PL-13 files → identical hash to 877e84's own audited content.
- `.sdd/ledger/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa/entry.json` verified honest per §3.

## 6. Coverage trajectory

- **Gained:** SEC-10 v12 (the new backfill-honesty observation) — `FIRST_OBSERVATION`/`NOT_COMPARABLE`.
- **Unchanged:** all 57 observations carried from 877e84 — same evidenced result, same `observation_key`, re-confirmed against a byte-identical diff.
- **Lost:** none.

## 7. Limitations

Identical to 877e84's own Limitations, plus: this run's own re-verification is a targeted re-confirmation (diff-hash equality, gate re-runs, the one new artifact) rather than a full re-derivation of every check from first principles — proportionate given the underlying code did not change, only the ledger/tree state around it did. Pre-existing, out-of-scope, disclosed only: `.sdd/ledger/index.json` still carries ~42-44 committed file keys pointing at paths now parked outside the repo, all owned by the already-committed PL-11 run `728516` (independently spot-checked this session, confirmed pre-existing and not this reconciliation's doing).

## 8. Cleanup

No fixtures created. Same commands as 877e84 (all read-only or unmodified repository commands) plus `npm run check:ledger-index` and one `git hash-object` invocation over the unmodified diff. No file created, modified, or left behind by this audit outside `.pipeline/security-history/20260809T073006612Z-010b2fe50c72-PR_DELTA-7ff0f1/` itself and the `.pipeline/security-report.md`/`.pipeline/security.json` handoff files.

## 9. Recheck scope

Unchanged from 877e84 (see that run's report.md §11) for all six persisting findings. For the ledger-tear class specifically: no code fix is required (the tear was in the operational sequencing of the reconciliation, not in `ledger-append.mjs`/`build-ledger-index.mjs` themselves, both confirmed still passing their own checks) — the recheck here IS this run: a clean `security` `PASS` against the reconciled tree, so `ledger-append --inline` can complete without re-tearing.

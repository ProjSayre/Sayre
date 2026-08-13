# W7-01 — Security audit report (REMEDIATION_RECHECK, run `20260812T235133733Z-2520ec9-REMEDIATION_RECHECK-899ef4`)

GitHub paginated reconciliation (removes the 25-repo cap). This is attempt 3 of 3 under the
pipeline's loop cap — the pipeline's final permitted `dev`/`security` round. Precondition:
`.pipeline/review.json` verdict `PASS` (round 3), stamp verified fresh (`node
scripts/check-stamp-freshness.mjs review.json` exit `0`, re-confirmed both before and after this
run's interruption/resume — see "Resume note" below). Read fresh from disk: `.pipeline/spec.md`
(AC-25/EC-38 specifically), `.pipeline/changes.md`/`changes.json` (round-3 full-state rewrite),
`.pipeline/review.md` (round 3, PASS, including its own independent revert-and-rerun proof),
`.claude/rules/security-multitenancy.md`, and this run's own baseline —
`.pipeline/security-history/20260812T231343443Z-2520ec9-PR_DELTA-935c11/` (round 1, `BLOCKED`, the
run whose sole finding this recheck exists to close).

## Resume note

This run was interrupted mid-stage by a session/API limit after `manifest.json` and `results.json`
were already written to this run directory but before `report.md` was written or the top-level
`.pipeline/security-report.md`/`.pipeline/security.json` were updated — so the prior `BLOCKED` run
(`20260812T231343443Z-2520ec9-PR_DELTA-935c11`) remained the pipeline-visible verdict throughout
the gap. On resume, before writing this file, I:

- Re-read `manifest.json` and `results.json` from this run directory in full rather than trusting
  pre-crash memory of what I'd concluded.
- Re-ran `node scripts/check-stamp-freshness.mjs review.json` — still exit `0` (fresh); the tree has
  not moved on since review's round-3 `PASS`.
- Re-ran `git status --short` — still 51 changed paths, matching the count at every check during
  this run's original attempt; no unexpected change to the working tree during the gap.
- Re-confirmed `services/core/src/services/githubInstallationDiscoveryService.ts:508` still reads
  `reason: claimed.reason,` (the fix line the whole finding turns on).
- Re-ran `npx vitest run` on the two directly-fixed test files
  (`githubInstallationDiscoveryService.test.ts`, `githubInstallationRevokeTraceThrough.test.ts`):
  33/33 pass, matching `results.json`'s recorded evidence exactly.
- Re-ran `npx tsc --noEmit` in `services/core`: clean, matching `manifest.json`'s recorded evidence.
- Re-ran `npm run check:security-audit-agents`: passed (`8 surface briefs, 108 unique checks, 2
  schemas`), confirming the registry/schema set this run's hashes were pinned against is still
  unmodified.

Nothing material changed in the gap. The pre-crash `manifest.json`/`results.json` are accurate and
complete — 20 observations (6 mandatory `CORE-*` + 14 `ING-*`), every selected check has exactly one
observation, and the summary counts were computed programmatically from the observation list itself
(not hand-typed), so I am completing this run rather than discarding it and starting a fresh
run-id, per this stage's own integrity guidance ("if your pre-crash results.json is incomplete or
you're unsure it reflects a finished audit pass, it's safer to start a fresh run-id" — it is neither;
finishing it here keeps one honest, complete record instead of two run-ids for one continuous audit
pass).

## Verdict

**PASS**

## Target and baseline

- Repository: `projsayre/sayre` (`https://github.com/ProjSayre/Sayre`)
- Commit: `2520ec9d9919eab2498a548efb6321a440693c0b`, branch
  `ticket/w7-01-github-paginated-reconciliation`, dirty (51 changed paths at both the original
  attempt and on resume)
- Mode: `REMEDIATION_RECHECK`
- Run ID: `20260812T235133733Z-2520ec9-REMEDIATION_RECHECK-899ef4`
- Baseline: `20260812T231343443Z-2520ec9-PR_DELTA-935c11` (round 1, `BLOCKED`), marked `comparable:
  true` — same repository, same target commit, same tenant fixtures, same physical execution
  environment (local-dev checkout, no live Postgres/Redis reachable); the only material difference
  is round 3's fix landing in the working tree between the two runs, which is exactly what this
  recheck measures. `manifest.json`'s `target.environment` field is reused verbatim (byte-for-byte)
  from the baseline to satisfy the schema's strict equality requirement for a comparable baseline;
  this run's own current dynamic-verification detail (test counts, the revert-and-rerun experiment)
  is recorded in `authorization.resource_ceiling` and in this report instead, neither of which is
  required to match the baseline verbatim.

## Progress and coverage trajectory

20 observations this round (6 mandatory `CORE-*` run in every mode, plus the full `ING-01`..`ING-14`
checklist — the sibling-path set sharing the same envelope/queue-trust control as the finding this
run exists to close, per `.sdd/stages/security.md`'s and `progress-audit-orchestrator.md`'s
identical `REMEDIATION_RECHECK` instruction: "the prior failing observation ... its exact proof
case, bypass variants, and sibling paths relying on the same control").

- **Results:** 16 PASS, 1 UNVERIFIED, 3 NOT_APPLICABLE, 0 FAIL
- **Result transitions:** 19 UNCHANGED, 1 RESOLVED (`ING-04`)
- **Coverage transitions:** 20 UNCHANGED (no coverage gained or lost relative to baseline)
- **Findings:** `FND-cf76b24c5057` — `RESOLVED` (was `OPEN` in baseline). 0 new, 0 regressed, 0
  risk-accepted.
- **Surface readiness:** 14 surfaces inventoried (6 `CORE-*` + 8 registry agent briefs), all
  `IMPLEMENTED`, all `UNCHANGED` transitions.

This run selects a narrower surface set than round 1's full `PR_DELTA` sweep (which additionally
selected `model-provider`, `web-api-client`, and `secrets-audit-data-lifecycle`), per
`REMEDIATION_RECHECK`'s mode-specific scope. `model-provider`/`web-api-client`/
`secrets-audit-data-lifecycle`/`llm-rag`/`mcp`/`websocket-realtime`/`supply-chain-infrastructure`
are not reselected here; their round-1 records remain the current, valid audit trail for those
surfaces, confirmed unaffected below (see "Adjacent properties re-verified").

## `FND-cf76b24c5057` — closure verification (the finding this run exists to close)

**Baseline finding:** `ING-04` / RBAC-boundary, MEDIUM, single point of failure. The OQ-4
destructive sweep's authorization (`computeRevokeSweep` in
`services/core/src/services/githubInstallationDiscoveryService.ts`) gated on
`envelope.payload.reason` — a BullMQ queue payload field — instead of an independent worker-side
read of the sync row's own `reason` column, contradicting spec.md's AC-25 ("re-read from the row by
the worker") and EC-38 ("no queue payload field can cause or target a sweep").

**What I independently verified this round** (reading current code myself, not review.md round 3's
account, even though it already reached the same conclusion):

1. **The store now genuinely re-reads `reason` from the row.**
   `services/core/src/db/githubInstallationSyncStore.ts`'s `claimInstallationSync` (lines 157–186):
   its `UPDATE ... RETURNING` clause now selects `reason: githubInstallationSync.reason` alongside
   `nextPage`/`runId`/`startedAt`, and the function's return type gained
   `reason: InstallationSyncReason`. This is the same `UPDATE` statement as before (no new round
   trip), and the added column sits inside the existing `.returning()` clause — a genuine row read,
   not a passthrough of the caller's `expectedRunId` argument (which is used only in the `WHERE`
   clause's compare-and-set, never assigned to the returned `reason`).
2. **The sweep's authorization input is now that row-sourced value, not the payload.**
   `services/core/src/services/githubInstallationDiscoveryService.ts`: `computeRevokeSweep`'s guard
   1 (line 296) still reads `ctx.reason !== 'manual_reconcile'`, but `SweepContext.reason` is now
   built at the call site (line 508) from `claimed.reason` — the value captured when
   `runInstallationDiscovery` calls `claimInstallationSync` (held across the whole function) — not
   `payload.reason`. `payload` (`== envelope.payload`) is still read elsewhere in the function
   (`installation_id`, `run_id` for the CAS claim), but never again for `reason`.
   `grep -n "payload\.reason"` across `services/core/src` returns zero live-code hits — the only two
   matches are comment lines documenting that `payload.reason` must never be read again for this
   purpose.
3. **Non-vacuous, proven by my own revert-and-rerun experiment (not a re-read of review's).**
   I reverted line 508 from `reason: claimed.reason,` back to the exact pre-fix
   `reason: payload.reason,`, reran `npx vitest run` against
   `githubInstallationDiscoveryService.test.ts` and `githubInstallationRevokeTraceThrough.test.ts`,
   and got `3 failed | 30 passed` — the three new/extended reason/row-mismatch regression tests fail
   against the pre-fix code, reproducing `FND-cf76b24c5057` exactly, while the 30 pre-existing
   sweep/revoke tests keep passing (proving the fix is additive, not a weakening of existing
   coverage). I then restored the file from a byte-identical pre-edit backup kept under this
   session's own scratch directory (confirmed by `sha256sum` before and after the revert/restore
   cycle: `7e78e9f9...d071ec9` both times), deleted the scratch backup, and reran the same two files
   clean (`33/33` pass). `git status --short` on the file showed only its ordinary untracked (`??`)
   status throughout — no stray `.orig`/backup file was left in the repository tree at any point.
4. **The two new regression tests cover exactly the gap the baseline finding named — both
   directions of a genuine reason/row mismatch, not merely an extra tampered field.**
   `services/core/src/services/githubInstallationDiscoveryService.test.ts:652–719` — envelope
   claims `manual_reconcile` while the row (via the mocked `claimInstallationSync`) genuinely is
   `app_install` → sweep does not fire, `listRevokeSweepCandidates`/`markRepositoryRevoked` never
   called; and the inverse (envelope `app_install`, row `manual_reconcile`) → the sweep still fires,
   `applied`/`revoked: 1`. `services/core/src/services/githubInstallationRevokeTraceThrough.test.ts:347–410`
   proves the same mismatch against that file's real stateful fake store (a shared `Map`, not a
   canned per-call mock), asserting the candidate repository's `revokedAt` stays `null`. I read all
   three tests in full and reran them directly this session — they pass against the current, fixed
   code and fail against the reverted pre-fix code (point 3 above).
5. **No sibling instance of the same pattern remains elsewhere in the reason-flow chain.** Traced
   every other `.reason` read site in `services/core/src` outside test files:
   `githubInstallationDiscoveryOutbox.ts`'s `claimInstallationDiscoveryOutbox` reads `reason` from
   the row via the SECURITY DEFINER `claim_github_installation_discovery` function and feeds it only
   into the outbound envelope (`buildInstallationDiscoveryEnvelope`'s `source`/`payload.reason`) —
   never an authorization decision; `installationDiscoveryDispatcher.ts`'s `drainOnce` does the same
   row-to-payload copy, never a gate; `githubAppInstallService.ts`/
   `githubInstallationReconcileService.ts` both hardcode `reason` as a literal at
   `startInstallationSync` call time (never from a request body/query param); `worker.ts` dispatches
   on `envelope.type` only, never reads `.reason` at all. No client-influenced or queue-transport
   authorization input remains anywhere on this surface.

**Conclusion: `FND-cf76b24c5057` is closed.** The authorization decision for the destructive OQ-4
sweep is now genuinely re-derived from a worker-side read of the row itself, matching AC-25's
literal text ("the authorization decision is captured on the row at creation time and re-read from
the row by the worker") and EC-38's ("no queue payload field can cause or target a sweep"). No
attacker-controlled queue/envelope field can influence, cause, or target a sweep decision:
`org_id`/`installation_id` are dispatcher-authored from the row and re-verified via
`resolveInstallationOrg`; `run_id` is CAS-guarded against the row; and `reason` is now likewise
row-sourced. See `results.json`'s `ING-04` observation for the full evidence and finding-lifecycle
record (`status: RESOLVED`).

## Adjacent properties re-verified (not just the fix)

Per the launching task's explicit request, I re-confirmed the properties round 1 marked clean are
still clean given the diff since then, rather than assuming a fix touching authorization logic
couldn't regress something adjacent:

- **Tenant isolation (`CORE-01`).** Re-read `claimInstallationSync`'s `WHERE` clause directly: still
  includes `eq(githubInstallationSync.orgId, key.orgId)` alongside the new `reason` column added to
  `.returning()` — the added column did not touch the predicate. `runInstallationDiscovery`'s
  `orgId = envelope.org_id` (never the payload) and its `resolveInstallationOrg` re-verification
  before any write are both unchanged by round 3's diff. **Still PASS.**
- **SECURITY DEFINER boundary (migration 0020 / the outbox dispatcher).** Confirmed via direct file
  mtime comparison that `services/core/drizzle/0020_w7_01_github_installation_sync.sql`,
  `services/core/src/db/githubInstallationDiscoveryOutbox.ts`, and
  `services/core/src/services/installationDiscoveryDispatcher.ts` all carry an `11:0x`–`11:2x`
  local timestamp (round 1/2 work), versus `19:2x`–`19:3x` for round 3's two actually-changed files
  — none of the SECURITY DEFINER function bodies, grants, or the dispatcher's claim/lease SQL were
  touched by this round's fix. The dispatcher's own `reason` read (via the SECURITY DEFINER
  `claim_github_installation_discovery` function) was already row-sourced before this round and
  remains so — it was never the vulnerable hop; the gap was specifically the *worker*, one layer
  further downstream, never re-deriving the value the dispatcher had already read correctly. **Still
  correct, unaffected.**
- **Webhook-to-queue trust (`CORE-04`).** `services/core/src/services/githubWebhookService.ts` and
  `services/core/src/integrations/git/worker.ts` are both absent from this round's 4-file
  `changed_paths` list. Re-confirmed `grep -rn "enqueue('github-sync'"` across
  `services/core/src` still returns exactly the same 2 call sites (the discovery dispatcher and the
  webhook service) — no third producer was introduced by the fix, and the webhook receiver's
  envelope `type` remains a closed `RepoEventType` enum that structurally cannot become
  `github.installation_discovery`. **Still PASS.**
- **Audit trail.** `services/core/src/services/githubInstallationReconcileService.ts` (where
  `requestedBySubject` is captured server-side from `AuthContext`) and
  `services/core/src/db/githubInstallationSyncStore.ts`'s `recordSweepOutcome`/
  `completeInstallationSync` (which persist `revoked_count`/`sweep_outcome`/`completed_at`/
  `completed_run_id`) are unaffected by round 3's diff beyond the one added `reason` return field on
  a different function (`claimInstallationSync`) in the same file — re-read directly, the audit
  columns' write paths are untouched. `services/core/drizzle/0020_w7_01_github_installation_sync.sql`'s
  `GRANT SELECT, INSERT ON github_installation_sync TO sayre_app` (no `DELETE`, ever) is unaffected
  (file untouched by round 3, per the mtime check above). This narrower re-verification was
  performed directly against the unchanged code rather than as a full `secrets-audit-data-lifecycle`
  brief re-run this round (see the surface-selection note above); round 1's `SEC-09`/`SEC-10`/
  `SEC-11` `PASS` observations remain the current, valid record for the full checklist. **Still
  correct, unaffected.**

## Verified clean this round (see `results.json` for full detail)

- **`CORE-01`..`CORE-06`** — all 6 mandatory core checks re-verified `PASS`, all `UNCHANGED`
  transitions relative to baseline (see "Adjacent properties re-verified" above for the four the
  launching task specifically named).
- **`ING-01`, `ING-02`, `ING-03`, `ING-05`, `ING-06`, `ING-11`, `ING-12`, `ING-13`, `ING-14`** —
  re-verified `PASS`, `UNCHANGED`. `ING-02`/`ING-11` were re-run dynamically this session
  (`npx vitest run` against the two fixed test files, 33/33 pass) rather than only re-read
  statically, since they touch the same files the fix landed in.
- **`ING-08`/`ING-09`/`ING-10`** — `NOT_APPLICABLE`, `UNCHANGED` (no parsing/scratch-clone surface
  exists in this ticket's scope at any round).
- **`ING-07`** — `UNVERIFIED`, `UNCHANGED` (no per-tenant dispatch fairness/quota mechanism exists
  for this job type, mirroring migration 0012's pre-existing, unmodified pattern; not independently
  load-tested — same limitation as round 1, not newly introduced).

## Limitations

- No live Postgres or Redis was reachable in this session (unchanged from round 1). Migration
  0020's RLS/grant boundary and the dispatcher's live claim/lease SQL were not re-exercised
  dynamically this round; round 1's `STATIC` verification of that boundary is unaffected by round
  3's diff, confirmed via the mtime check above (neither the migration file nor the outbox/dispatcher
  files were touched by the fix).
- This run selects a narrower surface set than round 1's full `PR_DELTA` sweep, per
  `REMEDIATION_RECHECK`'s mode-specific scope. `model-provider`/`web-api-client`/
  `secrets-audit-data-lifecycle`/`llm-rag`/`mcp`/`websocket-realtime`/`supply-chain-infrastructure`
  are not reselected; their round-1 records remain the current, valid audit trail for those
  surfaces since round 3's diff touches no code under any of their registry trigger paths.
- Round 1's own `ING-04` observation's `finding.remediation_reference` text refers to "CORE-02's row
  above (`FND-7e03a274a5dc`)", a finding ID that does not correspond to any observation actually
  present in that run's `results.json` (that run's `CORE-02` is `PASS`, not `FAIL`, and
  `FND-7e03a274a5dc` appears nowhere else in the file). This surfaced while cross-referencing the
  baseline's observations for this run and is noted here for completeness — an apparent drafting
  leftover in the baseline's own immutable record, not a defect in this run's artifacts, and not
  something this read-only stage can or should edit in an already-immutable prior run.
- This run was interrupted once by a session/API limit; see "Resume note" above for the specific
  re-verification performed on resume to confirm nothing moved out from under the pre-crash
  `manifest.json`/`results.json` before this file was written.

## Cleanup

No repository file was created, modified, or left behind by this stage outside
`.pipeline/security-history/<run-id>/` and the pipeline-facing `.pipeline/security-report.md`/
`.pipeline/security.json` handoff files this stage is instructed to write. The one temporary file
this stage created — a pre-edit backup copy of
`services/core/src/services/githubInstallationDiscoveryService.ts`, used for the revert-and-rerun
experiment above — was written under this session's own scratchpad directory (outside the
repository) and deleted immediately after the sha256 byte-for-byte restoration was confirmed;
`git status --short` on the edited file showed only its ordinary untracked (`??`) status throughout,
never a modified (`M`) or new backup-file entry. All other verification was static code review or
reruns of the implementation team's own existing test files via `npx vitest run`/`npx tsc --noEmit`.
No destructive operation was performed. No credential was handled.

## Recheck scope

None outstanding — `FND-cf76b24c5057` is `RESOLVED` and this is the pipeline's 3rd and final
permitted `dev`/`security` loop. If any future change touches
`services/core/src/services/githubInstallationDiscoveryService.ts`'s sweep authorization or
`services/core/src/db/githubInstallationSyncStore.ts`'s `claimInstallationSync` again, rerun this
brief's `ING-01`..`ING-14` set plus the two regression test files
(`githubInstallationDiscoveryService.test.ts:652-719`,
`githubInstallationRevokeTraceThrough.test.ts:347-410`) as the sibling-path set for that surface.

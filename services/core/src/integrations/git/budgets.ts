// W3-04 gapfill (GAP-2, GAP-3, GAP-5). Named budget/pagination/truncation constants for
// the git-sync integration worker, mirroring the Python fleet's own named-constant
// pattern (services/workers/sayre_workers/ingestion/budgets.py).

/**
 * W3-04 acceptance: "…within the sync target". PRD-V1.md:16 and :258 pin git delta sync at
 * <5s (tightened from 15s in v6). Deliberately TIGHTER than the Python fleet's
 * STRUCTURAL_SYNC_TARGET_MS = 15_000 (services/workers/sayre_workers/ingestion/budgets.py):
 * that budget covers a full Tree-sitter parse + graph projection; this one covers a metadata
 * delta only.
 */
export const GIT_SYNC_TARGET_MS: number = 5_000;

/**
 * Per-request hang guard for a provider API call. Deliberately LARGER than the target
 * above: it bounds a pathological stall, it is not the budget. A budget breach is
 * recorded, never used to abort an in-flight write.
 */
export const GIT_PROVIDER_REQUEST_TIMEOUT_MS: number = 10_000;

/** GitHub truncates the PR-files endpoint at 3000 files == 30 pages of 100. */
export const MAX_PULL_REQUEST_FILE_PAGES: number = 30;

/** GitHub push payloads carry at most 20 commits. */
export const GITHUB_PUSH_COMMIT_CAP: number = 20;

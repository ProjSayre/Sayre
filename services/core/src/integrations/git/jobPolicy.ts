// W3-04 gapfill (GAP-4). The GitHub webhook has already answered 202 by the time this job
// runs (docs/audits/deep-audit-2026-07-31/audit-04-webhooks-git.md:162-186), so GitHub will
// never redeliver: a single transient failure with enqueue()'s attempts:1 default
// permanently loses a merge. Scoped to this call site only (the `github-sync` enqueue in
// services/services/githubWebhookService.ts's publishOwnership); enqueue()'s queue-wide
// defaults are W0-04's — see spec.md's Open Question Q-3.
export const GIT_SYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  /** false => an exhausted job stays in BullMQ's `failed` set. That set IS the DLQ of
   *  record for this queue; nothing is silently deleted. */
  removeOnFail: false,
} as const;

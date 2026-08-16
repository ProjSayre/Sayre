// W3-04 gapfill (GAP-1b, GAP-2, GAP-5). git-sync-specific OpenTelemetry instruments,
// mirroring telemetry/graphMetrics.ts's cached-meter pattern. Every metric attribute is
// `org_id` + `provider` + `status` only — never a path, a repo name, or a token
// (spec.md's Approach step 6).

import { metrics, type Histogram, type MeterProvider, type Counter } from '@opentelemetry/api';

export const GIT_SYNC_DURATION_METRIC = 'git_sync_duration_ms';
export const GIT_SYNC_UNMATCHED_FILES_METRIC = 'git_sync_unmatched_files_total';
export const GIT_SYNC_BUDGET_BREACH_METRIC = 'git_sync_budget_breach_total';
export const GIT_SYNC_PUSH_TRUNCATED_METRIC = 'git_sync_push_truncated_total';

export interface GitSyncMetricAttributes {
  org_id: string;
  provider: string;
  status: string;
  [key: string]: string;
}

interface Instruments {
  duration: Histogram;
  unmatchedFiles: Counter;
  budgetBreach: Counter;
  pushTruncated: Counter;
}

let cachedProvider: MeterProvider | null = null;
let cachedInstruments: Instruments | null = null;

function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cachedInstruments === null || cachedProvider !== provider) {
    const meter = provider.getMeter('sayre.core.git-sync');
    cachedInstruments = {
      duration: meter.createHistogram(GIT_SYNC_DURATION_METRIC),
      unmatchedFiles: meter.createCounter(GIT_SYNC_UNMATCHED_FILES_METRIC),
      budgetBreach: meter.createCounter(GIT_SYNC_BUDGET_BREACH_METRIC),
      pushTruncated: meter.createCounter(GIT_SYNC_PUSH_TRUNCATED_METRIC),
    };
    cachedProvider = provider;
  }
  return cachedInstruments;
}

export function recordGitSyncDuration(durationMs: number, attributes: GitSyncMetricAttributes): void {
  instruments().duration.record(durationMs, attributes);
}

export function incrementGitSyncUnmatchedFiles(
  count: number,
  attributes: GitSyncMetricAttributes,
): void {
  if (count <= 0) return;
  instruments().unmatchedFiles.add(count, attributes);
}

export function incrementGitSyncBudgetBreach(attributes: GitSyncMetricAttributes): void {
  instruments().budgetBreach.add(1, attributes);
}

export function incrementGitSyncPushTruncated(attributes: GitSyncMetricAttributes): void {
  instruments().pushTruncated.add(1, attributes);
}

export function resetGitSyncMetricsForTests(): void {
  cachedProvider = null;
  cachedInstruments = null;
}

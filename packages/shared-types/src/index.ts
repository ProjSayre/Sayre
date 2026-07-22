export type ServiceName = 'web' | 'core' | 'workers';

export interface HealthStatus {
  status: 'ok';
  service: ServiceName;
  version: string; // e.g. "0.1.0"
  timestamp: string; // ISO 8601, new Date().toISOString()
}

export type RepoEventType = 'push' | 'pull_request' | 'branch';

export interface RepoRef {
  provider_repo_id: string; // stable provider repo id — GitHub numeric repo id as a string
  full_name: string; // "owner/name"
  repo_id: string | null; // internal repositories.id (UUID) if the repo is registered, else null
}

/**
 * Provider-generic normalized repo event. This is the shared contract between W1-02 (producer),
 * W1-05 (ingestion consumer), and W3-04 (ownership consumer / provider-generic requirement).
 * `org_id` is intentionally NOT a field here: it lives on the MessageEnvelope top level (the single
 * server-resolved source of truth) so it can never be shadowed by a payload value.
 */
export interface NormalizedRepoEvent {
  provider: 'github' | 'cursor-origin'; // W1-02 only ever emits 'github'; union kept for PM-06
  type: RepoEventType;
  repo: RepoRef;
  ref: string | null; // e.g. "refs/heads/main"; null when the event has no single ref
  installation_id: string; // provider account binding (GitHub App installation id, as string)
  delivery_id: string; // provider delivery id (X-GitHub-Delivery) — idempotency key
  payload: Record<string, unknown>; // normalized, event-type-specific subset
}

/**
 * Payload for the `repo.initial_parse` envelope, produced by W1-06's GitHub App
 * install callback (`services/core/src/services/githubAppInstallService.ts`) and
 * consumed by the (not-yet-built) W1-05 ingestion worker. Reuses the existing
 * `RepoRef` shape ({ provider_repo_id, full_name, repo_id }). `org_id` is
 * intentionally NOT a field here, same rationale as `NormalizedRepoEvent`: it
 * lives on the MessageEnvelope top level only.
 */
export interface RepoInitialParseEvent {
  provider: 'github' | 'cursor-origin'; // W1-06 emits 'github'; union kept for PM-06 parity
  type: 'initial_parse'; // payload discriminator (envelope.type is authoritative)
  repo: RepoRef; // repo_id populated after registration; provider_repo_id required
  ref: string; // non-null default branch, e.g. 'refs/heads/main'
  installation_id: string; // provider account binding, as string
  reason: 'app_install';
}

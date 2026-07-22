export type ServiceName = 'web' | 'core' | 'workers' | 'gateway';

export interface HealthStatus {
  status: 'ok';
  service: ServiceName;
  version: string; // e.g. "0.1.0"
  timestamp: string; // ISO 8601, new Date().toISOString()
}

/**
 * Coarse org-level role. Rank order (low to high): member < admin < owner.
 * Hoisted here (W2-03 O-4) from services/core/src/auth/context.ts, which
 * still defines the full AuthContext shape but re-exports this type rather
 * than redefining it -- single source of truth for both services/core (REST
 * authz) and services/gateway (WebSocket connection identity).
 */
export type OrgRole = 'owner' | 'admin' | 'member';

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

// --- W2-03: Realtime Service (WebSocket gateway + Redis pub/sub) wire contracts ---

/** Payload of the accepted `graph.updated` envelope (produced by W1-05,
 *  services/workers/sayre_workers/ingestion/events.py). Snake_case on the wire. */
export interface GraphUpdatedPayload {
  repository_id: string;
  ref_name: string;
  revision_sha: string;
  full_rebuild: boolean;
  changed_paths: string[];
  structural_duration_ms: number;
}

/** Canvas-renderable node -- Folder/File only (CLAUDE.md architecture rule).
 *  Structurally identical to services/core graph-query GraphNode; keep aligned. */
export interface CanvasNode {
  id: string;
  label: 'Folder' | 'File';
  name: string;
  path: string;
  parentId: string | null;
}

/** Core internal request body (data plane only -- NEVER carries org_id;
 *  Core resolves org_id server-side from the forwarded session token). */
export interface RealtimeDeltaRequest {
  repoId: string;
  changedPaths: string[];
  fullRebuild: boolean;
  graphVersion: number;
}

/** RBAC-filtered delta for one auth context. */
export interface RealtimeGraphDelta {
  repoId: string;
  graphVersion: number;
  upserts: CanvasNode[]; // authorized Folder/File nodes present among changed paths
  removals: string[]; // stable node UIDs the ctx WAS authorized to see and are now absent
  resyncRequired: boolean; // true on full_rebuild (client re-fetches tree over REST)
}

// WebSocket wire protocol (browser client <-> gateway)
export type ClientToGatewayMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; repoId: string }
  | { type: 'unsubscribe'; repoId: string };

export type GatewayToClientMessage =
  | { type: 'ready' }
  | { type: 'subscribed'; repoId: string }
  | { type: 'graph.delta'; repoId: string; graphVersion: number; upserts: CanvasNode[]; removals: string[] }
  | { type: 'graph.resync'; repoId: string; graphVersion: number }
  | { type: 'error'; code: string; message: string };

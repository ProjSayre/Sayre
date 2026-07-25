/**
 * Shapes used by the MVP UI mock.
 *
 * These intentionally mirror the real response contracts in `app/lib/*` so the
 * mock is a precursor to the production client rather than a throwaway. Nothing
 * here is fetched — every value is served from `fixtures.ts`.
 */

export type Role = 'member' | 'admin' | 'owner';

export type ViewId = 'technical' | 'product' | 'onboarding';

/** Readiness as the user sees it — never queue or worker terminology. */
export type RepositoryReadiness =
  | 'registered' // "Preparing repository"
  | 'technical-ready' // structural graph complete
  | 'graph-ready'; // structural + semantic complete

export interface Repository {
  id: string;
  provider: 'github';
  owner: string;
  name: string;
  defaultBranch: string;
  currentRef: string;
  readiness: RepositoryReadiness;
  fileCount: number;
  /** Set when the viewer is registered but not authorized on this repository. */
  restricted?: boolean;
}

export type NodeKind = 'Folder' | 'File';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  path: string;
  parentId: string | null;
}

/** Only CONTAINS and IMPORTS reach the canvas. CALLS/INHERITS stay internal. */
export type GraphEdgeType = 'CONTAINS' | 'IMPORTS';

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  source: string;
  target: string;
}

export interface OverlayDependency {
  nodeId: string;
  name: string;
  path: string;
  kind: NodeKind;
  direction: 'inbound' | 'outbound';
}

export interface OverlayRecentChange {
  sha: string;
  message: string;
  authorName: string;
  timestamp: string;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
}

export interface OverlayTicket {
  externalId: string;
  provider: 'jira' | 'linear';
  title: string;
  status: string;
  url: string;
}

export interface AgentSkillVersion {
  version: number;
  content: string;
  editorLabel: string;
  updatedAt: string;
}

export interface NodeOverlay {
  nodeId: string;
  description: string | null;
  agentSkillMd: AgentSkillVersion | null;
  agentSkillHistory: AgentSkillVersion[];
  recentChanges: OverlayRecentChange[];
  tickets: OverlayTicket[];
  /** Resolved style rules — reserved surface, no browser route yet. */
  standards: {
    codingStyle: string;
    commentStyle: string;
    inheritedFrom: string;
    overridden: boolean;
  } | null;
}

export interface FeatureRecentEdit {
  filePath: string;
  editorName: string;
  editedAt: string;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
}

export interface Feature {
  id: string;
  name: string;
  description: string;
  team: string;
  /** File node ids the feature spans — deliberately crosses folder boundaries. */
  fileIds: string[];
  recentEdits: FeatureRecentEdit[];
}

export type SemanticStatus = 'generating' | 'ready' | 'degraded' | 'failed';

export interface SemanticState {
  status: SemanticStatus;
  /** Sanitized, user-language reason. Never a provider stack trace. */
  reason: string | null;
  updatedAt: string;
}

export type RealtimeStatus =
  | 'connected'
  | 'reconnecting'
  | 'updated'
  | 'resync-required';

export type SessionState = 'authenticated' | 'signed-out' | 'session-expired';

export type BackendState = 'available' | 'unavailable';

export type RepositoryAccess =
  | 'authorized'
  | 'no-repositories'
  | 'repository-restricted'
  | 'forbidden';

export type InstallationOutcome =
  | 'not-installed'
  | 'installed'
  | 'approval-required'
  | 'denied'
  | 'error';

export type ProviderPurpose = 'generation' | 'embedding';

export interface ProviderSetting {
  purpose: ProviderPurpose;
  provider: string;
  model: string;
  /** A reference to a pre-provisioned credential — never a raw key. */
  credentialReference: string;
  endpoint: string;
  hosting: 'hosted' | 'self-hosted';
  status: 'configured' | 'incomplete';
}

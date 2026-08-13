/**
 * Stable presentation contracts for the modular workspace.
 *
 * Live and fixture adapters normalize into these types. Views, renderers, and
 * drawer modules never import transport details or invent a second backend
 * contract.
 */

import type {
  OverlayDependency,
  OverlayFeature,
  OverlayRecentChange,
  OverlayTicket,
} from '../lib/nodeOverlay';
import type {
  ProductTreeRecentEdit,
} from '../lib/productTree';
import type { PrerequisiteGraph } from '../lib/prerequisiteGraph';
import type {
  TechnicalTreeEdge,
} from '../lib/technicalTree';
import type {
  ProviderJobReason,
  ProviderJobStatus,
  ProviderSettingView,
  ProviderSettingsResponse,
} from '@sayre/shared-types';

export type Role = 'member' | 'admin' | 'owner';

export type ViewId = 'technical' | 'product' | 'onboarding';
export type SettingsSection = 'workspace-packs' | 'github' | 'providers' | 'mcp';

/** Exact repository-catalog values returned by the core service. */
export type RepositoryReadiness = 'registered' | 'graph_ready';

export interface Repository {
  id: string;
  provider: string;
  /** Server-returned display name, normally owner/repository. */
  name: string;
  defaultBranch: string | null;
  currentRef: string | null;
  readiness: RepositoryReadiness;
  /** Fixture-only marker used to exercise an unauthorized deep link. */
  restricted?: boolean;
}

/** W7-01: the workspace's partial-sync indicator, derived from `GET /repositories`'s `sync`. */
export type RepositoryImportSyncStatus = 'idle' | 'importing' | 'stalled' | 'failed';

export interface RepositoryImportSync {
  status: RepositoryImportSyncStatus;
  updatedAt: string | null;
  /** Admin/owner only; null for a member caller (server-side role gate). */
  discoveredRepositories: number | null;
  registeredRepositories: number | null;
}

export type NodeKind = 'Folder' | 'File';
export type CoverageStatus = 'pass' | 'fail' | 'stale' | 'unknown';

export interface GraphCoverage {
  status: CoverageStatus;
  lastRun: string | null;
  coveringTests: number;
}

export interface GraphNode {
  id: string;
  kind: 'Folder' | 'File';
  name: string;
  path: string;
  parentId: string | null;
  coverage?: GraphCoverage;
}
export type GraphEdge = TechnicalTreeEdge;

/**
 * The Onboarding view's edges are derived, not stored — reversed `IMPORTS`
 * meaning "understand this before that". They are typed separately from
 * `GraphEdge` so the two views cannot silently converge on one shape again,
 * which is how the Onboarding view became a filtered Technical tree.
 */
export interface OnboardingEdge {
  id: string;
  source: string;
  target: string;
  type: 'PREREQUISITE';
}

/**
 * Narrows a mixed edge list to the stored structural relations. Consumers built
 * for the Technical and Product views use this rather than being widened to
 * accept a derived relation they have no meaning for.
 */
export function isStructuralEdge(
  edge: GraphEdge | OnboardingEdge,
): edge is GraphEdge {
  return edge.type === 'CONTAINS' || edge.type === 'IMPORTS';
}

export interface Feature {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
  memberIds: string[];
  recentEdits: ProductTreeRecentEdit[];
}

export interface OnboardingStep {
  id: string;
  sequence: number;
  command: string;
  requires: string[];
}

export interface OnboardingWorkflow {
  revisionSha: string;
  steps: OnboardingStep[];
}

export interface ProductCoverage {
  totalFileCount: number;
  mappedFileCount: number;
  unmappedFileCount: number;
  mappedPercent: number;
}

export interface AgentSkillVersion {
  version: number;
  content: string;
  editorLabel: string;
  createdAt: string;
}

export interface NodeOverlay {
  nodeId: string;
  description: string | null;
  dependencies: Array<{
    nodeId: OverlayDependency['id'];
    name: OverlayDependency['name'];
    path: OverlayDependency['path'];
    kind: OverlayDependency['label'];
    direction: OverlayDependency['direction'];
  }>;
  specificFeatures: OverlayFeature[];
  agentSkillMd: AgentSkillVersion | null;
  agentSkillHistory: AgentSkillVersion[];
  recentChanges: OverlayRecentChange[];
  specificTickets: OverlayTicket[];
  /**
   * No browser route exists for resolved style rules yet. Kept as a capability
   * slot rather than filled with fixture-only values.
   */
  standards: null;
}

export type SemanticStatus = ProviderJobStatus;

export interface SemanticState {
  status: SemanticStatus;
  reasonCode: ProviderJobReason | null;
  /** Sanitized, user-language reason. Never a provider stack trace. */
  reason: string | null;
  updatedAt: string | null;
}

export type RealtimeStatus =
  | 'connected'
  | 'reconnecting'
  | 'updated'
  | 'resync-required'
  | 'not-connected';

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

export type ProviderSetting = ProviderSettingView;
export type ProviderSettings = ProviderSettingsResponse;

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WorkspaceGraph {
  nodes: GraphNode[];
  /**
   * Technical and Product carry stored `CONTAINS`/`IMPORTS`; Onboarding carries
   * derived `PREREQUISITE`. Consumers must switch on the view rather than
   * assuming one relation, which is what let the Onboarding view drift into
   * rendering the Technical tree.
   */
  edges: Array<GraphEdge | OnboardingEdge>;
  features: Feature[];
  onboarding: OnboardingWorkflow | null;
  /** Present only for the Onboarding view: per-node layer and cycle grouping. */
  prerequisite: PrerequisiteGraph | null;
  /**
   * Product Tree completeness is computed from the already-authorized
   * Technical Tree response. Null means the comparison was unavailable.
   */
  productCoverage: ProductCoverage | null;
}

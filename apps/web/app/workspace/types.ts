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

export type NodeKind = 'Folder' | 'File';
export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  path: string;
  parentId: string | null;
}
export type GraphEdge = TechnicalTreeEdge;

export interface Feature {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
  memberIds: string[];
  recentEdits: ProductTreeRecentEdit[];
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
  edges: GraphEdge[];
  features: Feature[];
}

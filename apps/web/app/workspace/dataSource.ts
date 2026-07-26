import type {
  ProviderJobState,
  ProviderPurpose,
  ProviderSettingsResponse,
  ProviderSettingsUpdateRequest,
  ProviderSettingView,
} from '@sayre/shared-types';
import {
  FEATURES,
  GRAPH_EDGES,
  GRAPH_NODES,
  NODE_OVERLAYS,
  PROVIDER_SETTINGS,
  REPOSITORIES,
} from '../mock/fixtures';
import {
  fetchAgentSkillMdHistory,
  fetchNodeOverlay,
  saveAgentSkillMd as saveAgentSkillMdRequest,
  type AgentSkillMdVersion,
  type NodeOverlayResponse,
} from '../lib/nodeOverlay';
import {
  fetchProductTree,
  type ProductTreeResponse,
} from '../lib/productTree';
import { fetchProviderState } from '../lib/providerState';
import { fetchRepositoryCatalog } from '../lib/repositoryCatalog';
import {
  fetchTechnicalTreeResponse,
  type TechnicalTreeResponse,
} from '../lib/technicalTree';
import type {
  AgentSkillVersion,
  Feature,
  GraphEdge,
  GraphNode,
  NodeOverlay,
  Repository,
} from './types';
import {
  parseProviderSettingsResponse,
  parseProviderSettingView,
} from './providerSettingsContract';

export interface WorkspaceScope {
  repositoryId: string;
  refName: string;
}

export interface WorkspaceDataSource {
  readonly id: 'live' | 'fixture';
  repositories(signal: AbortSignal): Promise<Repository[]>;
  technicalTree(
    scope: WorkspaceScope,
    signal: AbortSignal,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  productTree(
    scope: WorkspaceScope,
    signal: AbortSignal,
  ): Promise<{ nodes: GraphNode[]; features: Feature[] }>;
  providerState(
    scope: WorkspaceScope,
    signal: AbortSignal,
  ): Promise<ProviderJobState | null>;
  nodeOverlay(nodeId: string, signal: AbortSignal): Promise<NodeOverlay>;
  saveAgentSkillMd(
    nodeId: string,
    content: string,
    expectedVersion: number,
  ): Promise<AgentSkillVersion>;
  providerSettings(signal: AbortSignal): Promise<ProviderSettingsResponse>;
  saveProviderSetting(
    purpose: ProviderPurpose,
    update: ProviderSettingsUpdateRequest,
  ): Promise<ProviderSettingView>;
  readonly githubInstallUrl: string;
  readonly installationSummary: {
    accountName: string;
    repositoriesSynced: number;
    repositoriesTotal: number;
  } | null;
  readonly viewer: {
    name: string;
    initials: string;
    email: string;
    org: string;
  };
}

class WorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'WorkspaceRequestError';
  }
}

async function jsonRequest<T>(
  url: string,
  init: RequestInit,
  message: string,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) throw new WorkspaceRequestError(message, response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new WorkspaceRequestError(message, response.status);
  }
}

function graphNodes(
  nodes: TechnicalTreeResponse['nodes'] | ProductTreeResponse['nodes'],
): GraphNode[] {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.label,
    name: node.name,
    path: node.path,
    parentId: node.parentId,
  }));
}

function features(response: ProductTreeResponse): Feature[] {
  return response.features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    description: feature.description,
    team: feature.team,
    memberIds: [...feature.memberIds],
    recentEdits: [...feature.recentEdits],
  }));
}

function agentSkill(version: AgentSkillMdVersion): AgentSkillVersion {
  return {
    version: version.version,
    content: version.content,
    editorLabel: version.editorLabel,
    createdAt: version.createdAt,
  };
}

function overlay(
  response: NodeOverlayResponse,
  history: AgentSkillMdVersion[],
): NodeOverlay {
  return {
    nodeId: response.node.id,
    description: response.description,
    dependencies: response.dependencies.map((dependency) => ({
      nodeId: dependency.id,
      name: dependency.name,
      path: dependency.path,
      kind: dependency.label,
      direction: dependency.direction,
    })),
    specificFeatures: response.specificFeatures,
    agentSkillMd:
      response.agentSkillMd === null ? null : agentSkill(response.agentSkillMd),
    agentSkillHistory: history.map(agentSkill),
    recentChanges: response.recentChanges,
    specificTickets: response.specificTickets,
    standards: null,
  };
}

export const liveWorkspaceDataSource: WorkspaceDataSource = {
  id: 'live',
  githubInstallUrl: '/api/core/integrations/github/install',
  installationSummary: null,
  viewer: {
    name: 'Signed-in user',
    initials: 'SU',
    email: 'Session verified',
    org: 'Sayre workspace',
  },
  async repositories(signal) {
    return (await fetchRepositoryCatalog({ signal })).repositories;
  },
  async technicalTree(scope, signal) {
    const response = await fetchTechnicalTreeResponse(scope.repositoryId, {
      refName: scope.refName,
      signal,
    });
    return {
      nodes: graphNodes(response.nodes),
      edges: response.edges,
    };
  },
  async productTree(scope, signal) {
    const response = (
      await fetchProductTree(scope.repositoryId, scope.refName, { signal })
    ).response;
    return {
      nodes: graphNodes(response.nodes),
      features: features(response),
    };
  },
  providerState(scope, signal) {
    return fetchProviderState(
      {
        repositoryId: scope.repositoryId,
        refName: scope.refName,
        surface: 'product',
      },
      signal,
    );
  },
  async nodeOverlay(nodeId, signal) {
    const [response, history] = await Promise.all([
      fetchNodeOverlay(nodeId, { signal }),
      fetchAgentSkillMdHistory(nodeId, fetch, signal).catch(() => []),
    ]);
    return overlay(response, history);
  },
  async saveAgentSkillMd(nodeId, content, expectedVersion) {
    return agentSkill(
      await saveAgentSkillMdRequest(nodeId, content, expectedVersion),
    );
  },
  providerSettings(signal) {
    return jsonRequest<unknown>(
      '/api/core/settings/model-providers',
      { method: 'GET', signal },
      'Provider settings could not be loaded.',
    ).then(parseProviderSettingsResponse);
  },
  saveProviderSetting(purpose, update) {
    return jsonRequest<unknown>(
      `/api/core/settings/model-providers/${purpose}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      },
      'Provider settings could not be saved.',
    ).then(parseProviderSettingView);
  },
};

function fixtureOverlay(nodeId: string): NodeOverlay {
  const fixture = NODE_OVERLAYS[nodeId];
  const dependencies = GRAPH_EDGES.flatMap((edge) => {
    if (edge.type !== 'IMPORTS') return [];
    const direction =
      edge.source === nodeId
        ? 'outbound'
        : edge.target === nodeId
          ? 'inbound'
          : null;
    if (direction === null) return [];
    const relatedId = direction === 'outbound' ? edge.target : edge.source;
    const related = GRAPH_NODES.find((node) => node.id === relatedId);
    return related === undefined
      ? []
      : [{
          nodeId: related.id,
          name: related.name,
          path: related.path,
          kind: related.kind,
          direction,
        } as const];
  });
  const specificFeatures = FEATURES.filter((feature) =>
    feature.memberIds.includes(nodeId),
  ).map((feature) => ({
    id: feature.id,
    name: feature.name,
    description: feature.description,
    team: feature.team,
  }));
  return {
    nodeId,
    description: fixture?.description ?? null,
    dependencies,
    specificFeatures,
    agentSkillMd: fixture?.agentSkillMd ?? null,
    agentSkillHistory: fixture?.agentSkillHistory ?? [],
    recentChanges: fixture?.recentChanges ?? [],
    specificTickets: fixture?.specificTickets ?? [],
    standards: null,
  };
}

export const fixtureWorkspaceDataSource: WorkspaceDataSource = {
  id: 'fixture',
  githubInstallUrl: '#fixture-github-install',
  installationSummary: {
    accountName: 'acme',
    repositoriesSynced: 3,
    repositoriesTotal: 4,
  },
  viewer: {
    name: 'Alex Kwon',
    initials: 'AK',
    email: 'alex.kwon@acme.dev',
    org: 'Acme Engineering',
  },
  async repositories() {
    return REPOSITORIES;
  },
  async technicalTree() {
    return { nodes: GRAPH_NODES, edges: GRAPH_EDGES };
  },
  async productTree() {
    return { nodes: GRAPH_NODES, features: FEATURES };
  },
  async providerState(scope) {
    return {
      repositoryId: scope.repositoryId,
      refName: scope.refName,
      revisionSha: 'f'.repeat(40),
      surface: 'product',
      status: 'ready',
      reasonCode: null,
      updatedAt: '2026-07-25T14:12:00Z',
    };
  },
  async nodeOverlay(nodeId) {
    return fixtureOverlay(nodeId);
  },
  async saveAgentSkillMd(nodeId, content, expectedVersion) {
    return {
      version: expectedVersion + 1,
      content,
      editorLabel: 'You',
      createdAt: new Date().toISOString(),
    };
  },
  async providerSettings() {
    return {
      settings: {
        generation:
          PROVIDER_SETTINGS.find((setting) => setting.purpose === 'generation') ??
          null,
        embedding:
          PROVIDER_SETTINGS.find((setting) => setting.purpose === 'embedding') ??
          null,
      },
      credentialOptions: [
        {
          id: 'generation-anthropic-primary',
          label: 'Anthropic production credential',
          purpose: 'generation',
          providers: ['anthropic'],
        },
        {
          id: 'generation-openai-primary',
          label: 'OpenAI production credential',
          purpose: 'generation',
          providers: ['openai'],
        },
        {
          id: 'embedding-internal-primary',
          label: 'Internal embedding credential',
          purpose: 'embedding',
          providers: ['openai_compatible'],
        },
      ],
      endpointOptions: [
        {
          id: 'embedding-internal-v1',
          label: 'Internal embeddings · us-east',
          purpose: 'embedding',
          providers: ['openai_compatible'],
        },
      ],
      tradeoffs: {
        hostedGuarantee:
          'Hosted requests leave your network and are governed by the selected provider terms.',
        selfHostedGuarantee:
          'Approved self-hosted endpoints keep model traffic on infrastructure your organization controls.',
        quality:
          'Smaller local models can be faster or more private, but may produce noisier structured output.',
        latency:
          'Provider latency affects semantic features, never the structural graph.',
      },
    };
  },
  async saveProviderSetting(purpose, update) {
    return {
      purpose,
      ...update,
      credentialConfigured: update.credentialReferenceId !== null,
      endpointConfigured: update.endpointId !== null,
      updatedAt: new Date().toISOString(),
    };
  },
};

import type {
  McpClientKeyCreateRequest,
  McpClientKeyIssued,
  McpClientKeyView,
  McpKeySettingsResponse,
  ProviderJobState,
  ProviderJobSurface,
  ProviderPurpose,
  ProviderSettingsResponse,
  ProviderSettingsUpdateRequest,
  ProviderSettingView,
} from '@sayre/shared-types';
import {
  DEFAULT_REPOSITORY_ID,
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
  fetchOnboardingTree,
  runOnboardingStep,
  type OnboardingExecutionResponse,
} from '../lib/onboardingTree';
import {
  fetchProductTree,
  type ProductTreeResponse,
} from '../lib/productTree';
import { coreFetch } from '../lib/coreFetch';
import { fetchProviderState } from '../lib/providerState';
import {
  fetchGitHubIntegrationStatus,
  type GitHubIntegrationStatusResponse,
} from '../lib/githubIntegrationStatus';
import {
  disconnectJira as disconnectJiraRequest,
  fetchJiraIntegrationStatus,
  type JiraStatusResponse,
} from '../lib/jiraIntegrationStatus';
import { fetchRepositoryCatalog } from '../lib/repositoryCatalog';
import {
  fetchTechnicalTreeResponse,
  type TechnicalTreeResponse,
} from '../lib/technicalTree';
import {
  derivePrerequisiteGraph,
  type PrerequisiteGraph,
} from '../lib/prerequisiteGraph';
import type {
  AgentSkillVersion,
  Feature,
  GraphEdge,
  GraphNode,
  NodeOverlay,
  OnboardingEdge,
  OnboardingWorkflow,
  ProductCoverage,
  Repository,
} from './types';
import {
  parseMcpClientKey,
  parseMcpIssuedKey,
  parseMcpRateLimit,
  parseMcpSettingsResponse,
} from './mcpSettingsContract';
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
  ): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
    features: Feature[];
    productCoverage: ProductCoverage | null;
  }>;
  onboardingTree(
    scope: WorkspaceScope,
    signal: AbortSignal,
  ): Promise<{
    nodes: GraphNode[];
    edges: OnboardingEdge[];
    onboarding: OnboardingWorkflow;
    /** Reading order: per-node layer and cycle grouping. */
    prerequisite: PrerequisiteGraph;
  }>;
  runOnboardingStep(
    scope: WorkspaceScope,
    stepId: string,
  ): Promise<OnboardingExecutionResponse>;
  providerState(
    scope: WorkspaceScope,
    surface: ProviderJobSurface,
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
  mcpSettings(signal: AbortSignal): Promise<McpKeySettingsResponse>;
  issueMcpKey(
    request: McpClientKeyCreateRequest,
  ): Promise<McpClientKeyIssued>;
  revokeMcpKey(keyId: string): Promise<McpClientKeyView>;
  saveMcpRateLimit(
    rateLimitPerMinute: number,
  ): Promise<{ rateLimitPerMinute: number }>;
  githubIntegrationStatus(
    signal: AbortSignal,
  ): Promise<GitHubIntegrationStatusResponse>;
  readonly githubInstallUrl: string;
  jiraIntegrationStatus(signal: AbortSignal): Promise<JiraStatusResponse>;
  disconnectJira(): Promise<JiraStatusResponse>;
  readonly jiraConnectUrl: string;
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
  const response = await coreFetch(url, {
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
  return nodes.map((node) => {
    const coverage = 'coverage' in node ? node.coverage : undefined;
    return {
      id: node.id,
      kind: node.label,
      name: node.name,
      path: node.path,
      parentId: node.parentId,
      ...(coverage === undefined ? {} : { coverage }),
    };
  });
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

function summarizeProductCoverage(
  productResponse: ProductTreeResponse,
  technicalResponse: TechnicalTreeResponse | null,
): ProductCoverage | null {
  if (technicalResponse === null) return null;
  const authorizedFileIds = new Set(
    technicalResponse.nodes
      .filter((node) => node.label === 'File')
      .map((node) => node.id),
  );
  const mappedFileIds = new Set(
    productResponse.features.flatMap((feature) =>
      feature.memberIds.filter((memberId) => authorizedFileIds.has(memberId)),
    ),
  );
  const totalFileCount = authorizedFileIds.size;
  const mappedFileCount = mappedFileIds.size;
  return {
    totalFileCount,
    mappedFileCount,
    unmappedFileCount: Math.max(0, totalFileCount - mappedFileCount),
    mappedPercent:
      totalFileCount === 0
        ? 0
        : Math.round((mappedFileCount / totalFileCount) * 100),
  };
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
  jiraConnectUrl: '/api/core/integrations/jira/connect',
  viewer: {
    name: 'Signed-in user',
    initials: 'SU',
    email: 'Session verified',
    org: 'Sayre workspace',
  },
  async repositories(signal) {
    return (await fetchRepositoryCatalog({ signal })).repositories;
  },
  async githubIntegrationStatus(signal) {
    return fetchGitHubIntegrationStatus({ signal });
  },
  async jiraIntegrationStatus(signal) {
    return fetchJiraIntegrationStatus({ signal });
  },
  async disconnectJira() {
    return disconnectJiraRequest();
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
    const [presentation, technicalTree] = await Promise.all([
      fetchProductTree(scope.repositoryId, scope.refName, { signal }),
      fetchTechnicalTreeResponse(scope.repositoryId, {
        refName: scope.refName,
        signal,
      }).catch((error: unknown) => {
        // Product data is the required contract. Technical Tree imports are an
        // optional, already-authorized enrichment for feature-to-feature links.
        // Do not make the Product Tree unavailable if that secondary view fails.
        if (signal.aborted) throw error;
        return null;
      }),
    ]);
    const response = presentation.response;
    const productNodeIds = new Set(response.nodes.map(({ id }) => id));
    return {
      nodes: graphNodes(response.nodes),
      edges:
        technicalTree?.edges.filter(
          (edge) =>
            edge.type === 'IMPORTS' &&
            productNodeIds.has(edge.source) &&
            productNodeIds.has(edge.target),
        ) ?? [],
      features: features(response),
      productCoverage: summarizeProductCoverage(response, technicalTree),
    };
  },
  async onboardingTree(scope, signal) {
    const presentation = await fetchOnboardingTree(
      scope.repositoryId,
      scope.refName,
      { signal },
    );
    // Files only: the reading order is over units of understanding, and
    // including folders would reproduce the Technical tree's shape.
    const fileIds = new Set(presentation.prerequisite.nodes.map(({ id }) => id));
    return {
      nodes: graphNodes(
        presentation.response.nodes.filter((node) => fileIds.has(node.id)),
      ),
      edges: presentation.prerequisite.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'PREREQUISITE' as const,
      })),
      onboarding: {
        revisionSha: presentation.response.revisionSha,
        steps: presentation.response.steps.map((step) => ({
          ...step,
          requires: [...step.requires],
        })),
      },
      prerequisite: presentation.prerequisite,
    };
  },
  runOnboardingStep(scope, stepId) {
    return runOnboardingStep(scope.repositoryId, scope.refName, stepId, coreFetch);
  },
  providerState(scope, surface, signal) {
    return fetchProviderState(
      {
        repositoryId: scope.repositoryId,
        refName: scope.refName,
        surface,
      },
      signal,
    );
  },
  async nodeOverlay(nodeId, signal) {
    const [response, history] = await Promise.all([
      fetchNodeOverlay(nodeId, { signal }),
      fetchAgentSkillMdHistory(nodeId, coreFetch, signal).catch(() => []),
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
  mcpSettings(signal) {
    return jsonRequest<unknown>(
      '/api/mcp-settings',
      { method: 'GET', signal, cache: 'no-store' },
      'MCP settings could not be loaded.',
    ).then(parseMcpSettingsResponse);
  },
  issueMcpKey(request) {
    return jsonRequest<unknown>(
      '/api/mcp-settings/keys',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
      'The MCP credential could not be issued.',
    ).then(parseMcpIssuedKey);
  },
  revokeMcpKey(keyId) {
    return jsonRequest<unknown>(
      `/api/mcp-settings/keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
      'The MCP credential could not be revoked.',
    ).then(parseMcpClientKey);
  },
  saveMcpRateLimit(rateLimitPerMinute) {
    return jsonRequest<unknown>(
      '/api/mcp-settings/rate-limit',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rateLimitPerMinute }),
      },
      'The MCP rate limit could not be saved.',
    ).then(parseMcpRateLimit);
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

const FIXTURE_MCP_KEY: McpClientKeyView = {
  id: '77777777-7777-4777-8777-777777777777',
  name: 'Local planning agent',
  keyPrefix: 'mcp_live_0123456789abcdef',
  grants: [
    {
      repoId: DEFAULT_REPOSITORY_ID,
      branch: 'refs/heads/main',
      pathPrefix: null,
    },
  ],
  expiresAt: null,
  createdAt: '2026-07-24T17:20:00.000Z',
  createdByLabel: 'Alex Kwon',
  revokedAt: null,
  revokedByLabel: null,
  lastUsedAt: '2026-07-25T14:10:00.000Z',
};

const fixtureMcpKeys = new Map<string, McpClientKeyView>([
  [FIXTURE_MCP_KEY.id, FIXTURE_MCP_KEY],
]);

function defaultFixtureJiraConnection(): JiraStatusResponse['connection'] {
  return {
    connected: true,
    siteUrl: 'https://acme.atlassian.net',
    siteName: 'Acme',
    connectedByLabel: 'Alex Kwon',
    connectedByAccountId: 'fixture-jira-account-id',
    lastSyncedAt: '2026-07-25T14:10:00.000Z',
    connectedAt: '2026-07-20T09:00:00.000Z',
  };
}

let fixtureJiraConnection: JiraStatusResponse['connection'] =
  defaultFixtureJiraConnection();

/**
 * Fixture-only demo affordance: there is no real Atlassian consent screen in
 * fixture mode, so the Settings "Connect" action calls this helper directly
 * instead of a fourth `WorkspaceDataSource` member. Not part of the live
 * contract.
 */
export function reconnectFixtureJira(): void {
  fixtureJiraConnection = defaultFixtureJiraConnection();
}

export const fixtureWorkspaceDataSource: WorkspaceDataSource = {
  id: 'fixture',
  githubInstallUrl: '#fixture-github-install',
  jiraConnectUrl: '#fixture-jira-connect',
  viewer: {
    name: 'Alex Kwon',
    initials: 'AK',
    email: 'alex.kwon@acme.dev',
    org: 'Acme Engineering',
  },
  async repositories() {
    return REPOSITORIES;
  },
  async githubIntegrationStatus() {
    return {
      authorization: 'server-filtered',
      installations: [
        {
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          state: 'active',
          updatedAt: '2026-07-25T14:12:00.000Z',
        },
      ],
      repositories: REPOSITORIES.map((repository, index) => ({
        id: repository.id,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        currentRef: repository.currentRef,
        state: index === REPOSITORIES.length - 1 ? 'preparing' : 'ready',
        registeredAt: '2026-07-25T14:10:00.000Z',
      })),
      updatedAt: '2026-07-25T14:12:00.000Z',
    };
  },
  async jiraIntegrationStatus() {
    return {
      authorization: 'server-filtered',
      connection: fixtureJiraConnection,
      updatedAt: new Date().toISOString(),
    };
  },
  async disconnectJira() {
    fixtureJiraConnection = null;
    return {
      authorization: 'server-filtered',
      connection: fixtureJiraConnection,
      updatedAt: new Date().toISOString(),
    };
  },
  async technicalTree() {
    return { nodes: GRAPH_NODES, edges: GRAPH_EDGES };
  },
  async productTree() {
    const featureMemberIds = new Set(
      FEATURES.flatMap((feature) => feature.memberIds),
    );
    const totalFileCount = GRAPH_NODES.filter(
      (node) => node.kind === 'File',
    ).length;
    const mappedFileCount = [...featureMemberIds].filter((memberId) =>
      GRAPH_NODES.some(
        (node) => node.id === memberId && node.kind === 'File',
      ),
    ).length;
    return {
      nodes: GRAPH_NODES,
      edges: GRAPH_EDGES.filter(
        (edge) =>
          edge.type === 'IMPORTS' &&
          featureMemberIds.has(edge.source) &&
          featureMemberIds.has(edge.target),
      ),
      features: FEATURES,
      productCoverage: {
        totalFileCount,
        mappedFileCount,
        unmappedFileCount: Math.max(0, totalFileCount - mappedFileCount),
        mappedPercent:
          totalFileCount === 0
            ? 0
            : Math.round((mappedFileCount / totalFileCount) * 100),
      },
    };
  },
  async onboardingTree() {
    // Derived through the same path as the live source so the fixture lab shows
    // the real reading order rather than a hand-authored approximation of it.
    const prerequisite = derivePrerequisiteGraph(
      GRAPH_NODES.map((node) => ({
        id: node.id,
        label: node.kind,
        name: node.name,
        path: node.path,
        parentId: node.parentId,
      })),
      GRAPH_EDGES,
    );
    const fileIds = new Set(prerequisite.nodes.map(({ id }) => id));
    return {
      nodes: GRAPH_NODES.filter((node) => fileIds.has(node.id)),
      edges: prerequisite.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'PREREQUISITE' as const,
      })),
      prerequisite,
      onboarding: {
        revisionSha: 'f'.repeat(40),
        steps: [
          {
            id: 'fixture-install',
            sequence: 0,
            command: 'npm install',
            requires: [],
          },
          {
            id: 'fixture-check',
            sequence: 1,
            command: 'npm run build',
            requires: ['fixture-install'],
          },
        ],
      },
    };
  },
  async runOnboardingStep(_scope, stepId) {
    const sequence = stepId === 'fixture-install' ? 0 : 1;
    return {
      sandbox: 'container',
      status: 'succeeded',
      exitCode: 0,
      stdout: 'Fixture sandbox step completed.',
      stderr: '',
      durationMs: 480,
      stepId,
      sequence,
      revisionSha: 'f'.repeat(40),
    };
  },
  async providerState(scope, surface) {
    return {
      repositoryId: scope.repositoryId,
      refName: scope.refName,
      revisionSha: 'f'.repeat(40),
      surface,
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
  async mcpSettings() {
    return {
      keys: [...fixtureMcpKeys.values()],
      rateLimitPerMinute: 60,
    };
  },
  async issueMcpKey(request) {
    const id = crypto.randomUUID();
    const keyPrefix = `mcp_live_${id.replaceAll('-', '').slice(0, 16)}`;
    const issued: McpClientKeyIssued = {
      id,
      name: request.name,
      keyPrefix,
      grants: request.grants,
      expiresAt: request.expiresAt,
      createdAt: new Date().toISOString(),
      createdByLabel: 'Alex Kwon',
      revokedAt: null,
      revokedByLabel: null,
      lastUsedAt: null,
      token: `${keyPrefix}.${'A'.repeat(43)}`,
    };
    const { token: _token, ...view } = issued;
    fixtureMcpKeys.set(view.id, view);
    return issued;
  },
  async revokeMcpKey(keyId) {
    const key = fixtureMcpKeys.get(keyId);
    if (key === undefined) {
      throw new WorkspaceRequestError('Fixture MCP credential not found.', 404);
    }
    const revoked: McpClientKeyView = {
      ...key,
      revokedAt: new Date().toISOString(),
      revokedByLabel: 'Alex Kwon',
    };
    fixtureMcpKeys.set(keyId, revoked);
    return revoked;
  },
  async saveMcpRateLimit(rateLimitPerMinute) {
    return { rateLimitPerMinute };
  },
};

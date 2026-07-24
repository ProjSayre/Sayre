export interface OverlayDependency {
  id: string;
  label: 'Folder' | 'File';
  name: string;
  path: string;
  relationship: 'IMPORTS';
  direction: 'outbound' | 'inbound';
}

export interface OverlayRecentChange {
  commitId: string;
  sha: string;
  message: string | null;
  timestamp: string;
  authorName: string | null;
  authorLogin: string | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
}

export interface OverlayFeature {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
}

export interface OverlayTicket {
  id: string;
  externalId: string;
  system: string;
  title: string | null;
  status: string | null;
  url: string | null;
}

export interface AgentSkillMdVersion {
  version: number;
  content: string;
  editorUserId: string | null;
  editorLabel: string;
  createdAt: string;
}

export interface NodeOverlayResponse {
  authorization: 'server-filtered';
  node: {
    id: string;
    label: 'Folder' | 'File';
    name: string;
    path: string;
    repositoryId: string;
    refName: string;
    revisionSha: string;
  };
  dependencies: OverlayDependency[];
  recentChanges: OverlayRecentChange[];
  specificFeatures: OverlayFeature[];
  agentSkillMd: AgentSkillMdVersion | null;
  description: string | null;
  specificTickets: OverlayTicket[];
}

export interface FetchNodeOverlayOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class NodeOverlayResponseError extends Error {
  constructor() {
    super('The node overlay response is invalid.');
    this.name = 'NodeOverlayResponseError';
  }
}

export class NodeOverlayRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly currentVersion: number | null = null,
  ) {
    super(message);
    this.name = 'NodeOverlayRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(record: Record<string, unknown>, field: string, empty = false): string {
  const value = record[field];
  if (typeof value !== 'string' || (!empty && !value.trim())) {
    throw new NodeOverlayResponseError();
  }
  return value;
}

function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value !== null && typeof value !== 'string') {
    throw new NodeOverlayResponseError();
  }
  return value as string | null;
}

function array<T>(
  value: unknown,
  parser: (record: Record<string, unknown>) => T,
): T[] {
  if (!Array.isArray(value)) throw new NodeOverlayResponseError();
  return value.map((item) => {
    if (!isRecord(item)) throw new NodeOverlayResponseError();
    return parser(item);
  });
}

function parseAgentSkillMd(value: unknown): AgentSkillMdVersion | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1
  ) {
    throw new NodeOverlayResponseError();
  }
  const editorUserId = value.editorUserId;
  if (editorUserId !== null && typeof editorUserId !== 'string') {
    throw new NodeOverlayResponseError();
  }
  return {
    version: value.version as number,
    content: string(value, 'content'),
    editorUserId,
    editorLabel: string(value, 'editorLabel'),
    createdAt: string(value, 'createdAt'),
  };
}

export function parseNodeOverlayResponse(value: unknown): NodeOverlayResponse {
  if (!isRecord(value) || value.authorization !== 'server-filtered' || !isRecord(value.node)) {
    throw new NodeOverlayResponseError();
  }
  const node = value.node;
  const label = node.label;
  if (label !== 'Folder' && label !== 'File') throw new NodeOverlayResponseError();

  return {
    authorization: 'server-filtered',
    node: {
      id: string(node, 'id'),
      label,
      name: string(node, 'name'),
      path: string(node, 'path', true),
      repositoryId: string(node, 'repositoryId'),
      refName: string(node, 'refName'),
      revisionSha: string(node, 'revisionSha'),
    },
    dependencies: array(value.dependencies, (item) => {
      const itemLabel = item.label;
      const direction = item.direction;
      if (
        (itemLabel !== 'Folder' && itemLabel !== 'File') ||
        item.relationship !== 'IMPORTS' ||
        (direction !== 'outbound' && direction !== 'inbound')
      ) {
        throw new NodeOverlayResponseError();
      }
      return {
        id: string(item, 'id'),
        label: itemLabel,
        name: string(item, 'name'),
        path: string(item, 'path', true),
        relationship: 'IMPORTS',
        direction,
      };
    }),
    recentChanges: array(value.recentChanges, (item) => ({
      commitId: string(item, 'commitId'),
      sha: string(item, 'sha'),
      message: nullableString(item, 'message'),
      timestamp: string(item, 'timestamp'),
      authorName: nullableString(item, 'authorName'),
      authorLogin: nullableString(item, 'authorLogin'),
      pullRequestTitle: nullableString(item, 'pullRequestTitle'),
      pullRequestUrl: nullableString(item, 'pullRequestUrl'),
    })),
    specificFeatures: array(value.specificFeatures, (item) => ({
      id: string(item, 'id'),
      name: string(item, 'name'),
      description: nullableString(item, 'description'),
      team: nullableString(item, 'team'),
    })),
    agentSkillMd: parseAgentSkillMd(value.agentSkillMd),
    description: nullableString(value, 'description'),
    specificTickets: array(value.specificTickets, (item) => ({
      id: string(item, 'id'),
      externalId: string(item, 'externalId'),
      system: string(item, 'system'),
      title: nullableString(item, 'title'),
      status: nullableString(item, 'status'),
      url: nullableString(item, 'url'),
    })),
  };
}

function requestError(status: number): NodeOverlayRequestError {
  if (status === 401) return new NodeOverlayRequestError('Sign in to inspect this node.', status);
  if (status === 403) return new NodeOverlayRequestError('You do not have access to this node.', status);
  if (status === 404) return new NodeOverlayRequestError('This node is no longer available.', status);
  return new NodeOverlayRequestError('The node overlay could not be loaded.', status);
}

export async function fetchNodeOverlay(
  nodeId: string,
  options: FetchNodeOverlayOptions = {},
): Promise<NodeOverlayResponse> {
  const normalized = nodeId.trim();
  if (!normalized) throw new RangeError('A node ID is required.');
  const response = await (options.fetchImpl ?? fetch)(
    `/api/core/nodes/${encodeURIComponent(normalized)}/overlay`,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal: options.signal,
    },
  );
  if (!response.ok) throw requestError(response.status);
  try {
    return parseNodeOverlayResponse(await response.json());
  } catch (error) {
    if (error instanceof NodeOverlayResponseError) throw error;
    throw new NodeOverlayResponseError();
  }
}

export async function saveAgentSkillMd(
  nodeId: string,
  content: string,
  expectedVersion: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentSkillMdVersion> {
  const response = await fetchImpl(
    `/api/core/nodes/${encodeURIComponent(nodeId)}/agent-skill-md`,
    {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content, expectedVersion }),
    },
  );
  if (!response.ok) {
    if (response.status === 409) {
      let currentVersion: number | null = null;
      try {
        const body = await response.json() as { currentVersion?: unknown };
        if (Number.isSafeInteger(body.currentVersion)) {
          currentVersion = body.currentVersion as number;
        }
      } catch {
        // The safe conflict message does not depend on a response body.
      }
      throw new NodeOverlayRequestError(
        'This document changed in another session. Reload before saving.',
        409,
        currentVersion,
      );
    }
    if (response.status === 400) {
      throw new NodeOverlayRequestError(
        'Use the required Allowed Tools, Required Context, and Guardrails sections.',
        400,
      );
    }
    throw requestError(response.status);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new NodeOverlayResponseError();
  }
  if (!isRecord(value)) throw new NodeOverlayResponseError();
  const document = parseAgentSkillMd(value.document);
  if (document === null) throw new NodeOverlayResponseError();
  return document;
}

export async function fetchAgentSkillMdHistory(
  nodeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentSkillMdVersion[]> {
  const response = await fetchImpl(
    `/api/core/nodes/${encodeURIComponent(nodeId)}/agent-skill-md/history`,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    },
  );
  if (!response.ok) throw requestError(response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new NodeOverlayResponseError();
  }
  if (!isRecord(value) || !Array.isArray(value.versions)) {
    throw new NodeOverlayResponseError();
  }
  return value.versions.map((version) => {
    const parsed = parseAgentSkillMd(version);
    if (parsed === null) throw new NodeOverlayResponseError();
    return parsed;
  });
}

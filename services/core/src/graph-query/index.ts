import type { AuthContext } from '../auth/context';
import { LazyGraphReadExecutor, type GraphReadExecutor, type GraphReadRecord } from './neo4j';
import {
  PostgresPermissionStore,
  canReadResource,
  cypherRules,
  type PermissionStore,
  type ReadScope,
  type ScopedGraphResource,
} from './permissions';
import type {
  AffectedNodes,
  CanvasNodeLabel,
  GraphEdge,
  GraphNode,
  GraphQueryService,
  ResolvedStyleRules,
  ResolvedStyleValue,
  StyleRuleGraphQueryService,
  StructuralEdgeType,
  Viewport,
} from './types';

export * from './types';
export {
  PostgresPermissionStore,
  canReadResource,
  type AuthorizationRule,
  type PermissionStore,
  type ReadScope,
} from './permissions';

// Permission predicates intentionally run inside the graph query so hidden
// nodes do not cross the graph-store boundary. The TypeScript mapper repeats
// the same decision as defense in depth before returning any record.
export const GET_NODES_IN_VIEWPORT_CYPHER = `
MATCH (node)
WHERE (node:Folder OR node:File)
  AND node.org_id = $org_id
  AND node.repo_id = $repo_id
  AND node.uid IS NOT NULL
  AND node.name IS NOT NULL
  AND node.path IS NOT NULL
  AND node.ref_name IS NOT NULL
  AND (
    node.layout_x IS NULL OR node.layout_y IS NULL OR
    (node.layout_x >= $viewport_min_x AND node.layout_x <= $viewport_max_x AND
     node.layout_y >= $viewport_min_y AND node.layout_y <= $viewport_max_y)
  )
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
    (rule.branch IS NULL OR rule.branch = node.ref_name) AND
    (rule.path_prefix IS NULL OR node.path = rule.path_prefix OR
      node.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
    (rule.branch IS NULL OR rule.branch = node.ref_name) AND
    (rule.path_prefix IS NULL OR node.path = rule.path_prefix OR
      node.path STARTS WITH rule.path_prefix + '/'))
OPTIONAL MATCH (parent:Folder)-[parent_edge:CONTAINS]->(node)
WHERE parent.org_id = $org_id
  AND parent.repo_id = node.repo_id
  AND parent.ref_name = node.ref_name
  AND parent_edge.org_id = $org_id
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = parent.repo_id) AND
    (rule.branch IS NULL OR rule.branch = parent.ref_name) AND
    (rule.path_prefix IS NULL OR parent.path = rule.path_prefix OR
      parent.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = parent.repo_id) AND
    (rule.branch IS NULL OR rule.branch = parent.ref_name) AND
    (rule.path_prefix IS NULL OR parent.path = rule.path_prefix OR
      parent.path STARTS WITH rule.path_prefix + '/'))
RETURN node.uid AS id,
       CASE WHEN node:Folder THEN 'Folder' ELSE 'File' END AS label,
       node.name AS name,
       node.path AS path,
       node.repo_id AS repo_id,
       node.ref_name AS ref_name,
       parent.uid AS parent_id,
       parent.path AS parent_path,
       parent.repo_id AS parent_repo_id,
       parent.ref_name AS parent_ref_name
ORDER BY node.path, node.uid
`;

export const GET_STRUCTURAL_EDGES_CYPHER = `
MATCH (source)-[edge]->(target)
WHERE source.org_id = $org_id
  AND target.org_id = $org_id
  AND edge.org_id = $org_id
  AND source.uid IN $node_ids
  AND target.uid IN $node_ids
  AND (source:Folder OR source:File)
  AND (target:Folder OR target:File)
  AND type(edge) IN ['CONTAINS', 'IMPORTS']
  AND source.repo_id = target.repo_id
  AND source.ref_name = target.ref_name
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = source.repo_id) AND
    (rule.branch IS NULL OR rule.branch = source.ref_name) AND
    (rule.path_prefix IS NULL OR source.path = rule.path_prefix OR
      source.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = source.repo_id) AND
    (rule.branch IS NULL OR rule.branch = source.ref_name) AND
    (rule.path_prefix IS NULL OR source.path = rule.path_prefix OR
      source.path STARTS WITH rule.path_prefix + '/'))
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = target.repo_id) AND
    (rule.branch IS NULL OR rule.branch = target.ref_name) AND
    (rule.path_prefix IS NULL OR target.path = rule.path_prefix OR
      target.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = target.repo_id) AND
    (rule.branch IS NULL OR rule.branch = target.ref_name) AND
    (rule.path_prefix IS NULL OR target.path = rule.path_prefix OR
      target.path STARTS WITH rule.path_prefix + '/'))
RETURN type(edge) AS type,
       source.uid AS source_id,
       source.path AS source_path,
       source.repo_id AS source_repo_id,
       source.ref_name AS source_ref_name,
       target.uid AS target_id,
       target.path AS target_path,
       target.repo_id AS target_repo_id,
       target.ref_name AS target_ref_name
ORDER BY type, source_id, target_id
`;

export const GET_AFFECTED_NODES_CYPHER = `
MATCH (node)
WHERE (node:Folder OR node:File)
  AND node.org_id = $org_id
  AND node.repo_id = $repo_id
  AND node.path IN $paths
  AND node.uid IS NOT NULL
  AND node.name IS NOT NULL
  AND node.ref_name IS NOT NULL
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
    (rule.branch IS NULL OR rule.branch = node.ref_name) AND
    (rule.path_prefix IS NULL OR node.path = rule.path_prefix OR
      node.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
    (rule.branch IS NULL OR rule.branch = node.ref_name) AND
    (rule.path_prefix IS NULL OR node.path = rule.path_prefix OR
      node.path STARTS WITH rule.path_prefix + '/'))
OPTIONAL MATCH (parent:Folder)-[parent_edge:CONTAINS]->(node)
WHERE parent.org_id = $org_id
  AND parent.repo_id = node.repo_id
  AND parent.ref_name = node.ref_name
  AND parent_edge.org_id = $org_id
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = parent.repo_id) AND
    (rule.branch IS NULL OR rule.branch = parent.ref_name) AND
    (rule.path_prefix IS NULL OR parent.path = rule.path_prefix OR
      parent.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = parent.repo_id) AND
    (rule.branch IS NULL OR rule.branch = parent.ref_name) AND
    (rule.path_prefix IS NULL OR parent.path = rule.path_prefix OR
      parent.path STARTS WITH rule.path_prefix + '/'))
RETURN node.uid AS id,
       CASE WHEN node:Folder THEN 'Folder' ELSE 'File' END AS label,
       node.name AS name,
       node.path AS path,
       node.repo_id AS repo_id,
       node.ref_name AS ref_name,
       parent.uid AS parent_id,
       parent.path AS parent_path,
       parent.repo_id AS parent_repo_id,
       parent.ref_name AS parent_ref_name
ORDER BY node.path, node.uid
`;

export const RESOLVE_STYLE_RULES_CYPHER = `
MATCH (target)
WHERE (target:Folder OR target:File)
  AND target.org_id = $org_id
  AND target.uid = $node_id
  AND target.repo_id IS NOT NULL
  AND target.ref_name IS NOT NULL
  AND target.revision_sha IS NOT NULL
  AND target.path IS NOT NULL
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = target.repo_id) AND
    (rule.branch IS NULL OR rule.branch = target.ref_name) AND
    (rule.path_prefix IS NULL OR target.path = rule.path_prefix OR
      target.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = target.repo_id) AND
    (rule.branch IS NULL OR rule.branch = target.ref_name) AND
    (rule.path_prefix IS NULL OR target.path = rule.path_prefix OR
      target.path STARTS WITH rule.path_prefix + '/'))
OPTIONAL MATCH path = (ancestor:Folder)-[:CONTAINS*0..64]->(target)
WHERE ALL(path_node IN nodes(path) WHERE
    path_node.org_id = $org_id AND
    path_node.repo_id = target.repo_id AND
    path_node.ref_name = target.ref_name AND
    path_node.revision_sha = target.revision_sha AND
    path_node.path IS NOT NULL AND
    ANY(rule IN $allow_rules WHERE
      (rule.repo_id IS NULL OR rule.repo_id = path_node.repo_id) AND
      (rule.branch IS NULL OR rule.branch = path_node.ref_name) AND
      (rule.path_prefix IS NULL OR path_node.path = rule.path_prefix OR
        path_node.path STARTS WITH rule.path_prefix + '/')) AND
    NOT ANY(rule IN $deny_rules WHERE
      (rule.repo_id IS NULL OR rule.repo_id = path_node.repo_id) AND
      (rule.branch IS NULL OR rule.branch = path_node.ref_name) AND
      (rule.path_prefix IS NULL OR path_node.path = rule.path_prefix OR
        path_node.path STARTS WITH rule.path_prefix + '/')))
  AND ALL(path_edge IN relationships(path) WHERE path_edge.org_id = $org_id)
RETURN target.uid AS target_id,
       CASE WHEN target:Folder THEN 'Folder' ELSE 'File' END AS target_label,
       target.org_id AS target_org_id,
       target.path AS target_path,
       target.repo_id AS target_repo_id,
       target.ref_name AS target_ref_name,
       target.revision_sha AS target_revision_sha,
       target.coding_style AS target_coding_style,
       target.comment_style AS target_comment_style,
       ancestor.uid AS ancestor_id,
       CASE WHEN ancestor:Folder THEN 'Folder' ELSE NULL END AS ancestor_label,
       ancestor.org_id AS ancestor_org_id,
       ancestor.path AS ancestor_path,
       ancestor.repo_id AS ancestor_repo_id,
       ancestor.ref_name AS ancestor_ref_name,
       ancestor.revision_sha AS ancestor_revision_sha,
       ancestor.coding_style AS ancestor_coding_style,
       ancestor.comment_style AS ancestor_comment_style,
       length(path) AS ancestor_distance
ORDER BY ancestor_distance, ancestor.uid
`;

function valueAsString(record: GraphReadRecord, key: string): string | null {
  const value = record.get(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resourceFromRecord(
  record: GraphReadRecord,
  prefix = '',
): ScopedGraphResource | null {
  const repoId = valueAsString(record, `${prefix}repo_id`);
  const refName = valueAsString(record, `${prefix}ref_name`);
  const path = valueAsString(record, `${prefix}path`);
  return repoId && refName && path ? { repoId, refName, path } : null;
}

interface ScopedStyleResource extends ScopedGraphResource {
  orgId: string;
  revisionSha: string;
}

interface StyleCandidate {
  nodeId: string;
  distance: number;
  codingStyle: string | null;
  commentStyle: string | null;
}

const MAX_STYLE_RULE_CHARS = 2_048;

function styleResourceFromRecord(
  record: GraphReadRecord,
  prefix: string,
): ScopedStyleResource | null {
  const orgId = valueAsString(record, `${prefix}org_id`);
  const repoId = valueAsString(record, `${prefix}repo_id`);
  const refName = valueAsString(record, `${prefix}ref_name`);
  const revisionSha = valueAsString(record, `${prefix}revision_sha`);
  const path = record.get(`${prefix}path`);
  return orgId && repoId && refName && revisionSha && typeof path === 'string'
    ? { orgId, repoId, refName, revisionSha, path }
    : null;
}

function sameStyleScope(left: ScopedStyleResource, right: ScopedStyleResource): boolean {
  return (
    left.orgId === right.orgId &&
    left.repoId === right.repoId &&
    left.refName === right.refName &&
    left.revisionSha === right.revisionSha
  );
}

function valueAsStyle(record: GraphReadRecord, key: string): string | null {
  const value = record.get(key);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_STYLE_RULE_CHARS
    ? normalized
    : null;
}

function valueAsSafeInteger(record: GraphReadRecord, key: string): number | null {
  const value = record.get(key);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const toNumber = (value as { toNumber?: () => unknown }).toNumber;
  if (typeof toNumber !== 'function') return null;
  try {
    const converted = toNumber.call(value);
    return typeof converted === 'number' && Number.isSafeInteger(converted)
      ? converted
      : null;
  } catch {
    return null;
  }
}

function emptyStyleValue(): ResolvedStyleValue {
  return { value: null, sourceNodeId: null };
}

function nearestStyle(
  candidates: readonly StyleCandidate[],
  kind: 'codingStyle' | 'commentStyle',
): ResolvedStyleValue {
  const matching = candidates
    .filter((candidate) => candidate[kind] !== null)
    .sort(
      (left, right) =>
        left.distance - right.distance || left.nodeId.localeCompare(right.nodeId),
    );
  const nearest = matching[0];
  return nearest
    ? { value: nearest[kind], sourceNodeId: nearest.nodeId }
    : emptyStyleValue();
}

function resolveStyleRecords(
  records: readonly GraphReadRecord[],
  requestedNodeId: string,
  expectedOrgId: string,
  scope: ReadScope,
): ResolvedStyleRules | null {
  let target:
    | {
        label: CanvasNodeLabel;
        resource: ScopedStyleResource;
        codingStyle: string | null;
        commentStyle: string | null;
      }
    | undefined;
  const candidates: StyleCandidate[] = [];

  for (const record of records) {
    const targetId = valueAsString(record, 'target_id');
    const targetLabel = valueAsString(record, 'target_label');
    const targetResource = styleResourceFromRecord(record, 'target_');
    if (
      targetId !== requestedNodeId ||
      !isCanvasLabel(targetLabel) ||
      !targetResource ||
      targetResource.orgId !== expectedOrgId ||
      !canReadResource(scope, targetResource)
    ) {
      continue;
    }

    if (!target) {
      target = {
        label: targetLabel,
        resource: targetResource,
        codingStyle: valueAsStyle(record, 'target_coding_style'),
        commentStyle: valueAsStyle(record, 'target_comment_style'),
      };
    } else if (
      target.label !== targetLabel ||
      !sameStyleScope(target.resource, targetResource) ||
      target.resource.path !== targetResource.path
    ) {
      continue;
    }

    const ancestorId = valueAsString(record, 'ancestor_id');
    const ancestorLabel = valueAsString(record, 'ancestor_label');
    const ancestorResource = styleResourceFromRecord(record, 'ancestor_');
    const distance = valueAsSafeInteger(record, 'ancestor_distance');
    if (
      !ancestorId ||
      ancestorLabel !== 'Folder' ||
      !ancestorResource ||
      distance === null ||
      distance < 0 ||
      distance > 64 ||
      !sameStyleScope(target.resource, ancestorResource) ||
      !canReadResource(scope, ancestorResource)
    ) {
      continue;
    }
    candidates.push({
      nodeId: ancestorId,
      distance,
      codingStyle: valueAsStyle(record, 'ancestor_coding_style'),
      commentStyle: valueAsStyle(record, 'ancestor_comment_style'),
    });
  }

  if (!target) return null;
  return {
    nodeId: requestedNodeId,
    codingStyle: target.codingStyle
      ? { value: target.codingStyle, sourceNodeId: requestedNodeId }
      : nearestStyle(candidates, 'codingStyle'),
    commentStyle: target.commentStyle
      ? { value: target.commentStyle, sourceNodeId: requestedNodeId }
      : nearestStyle(candidates, 'commentStyle'),
  };
}

function isCanvasLabel(value: string | null): value is CanvasNodeLabel {
  return value === 'Folder' || value === 'File';
}

function mapNode(record: GraphReadRecord, scope: ReadScope): GraphNode | null {
  const id = valueAsString(record, 'id');
  const label = valueAsString(record, 'label');
  const name = valueAsString(record, 'name');
  const resource = resourceFromRecord(record);
  if (!id || !isCanvasLabel(label) || !name || !resource) return null;
  if (!canReadResource(scope, resource)) return null;

  const rawParentId = valueAsString(record, 'parent_id');
  const parentResource = resourceFromRecord(record, 'parent_');
  const parentId =
    rawParentId && parentResource && canReadResource(scope, parentResource)
      ? rawParentId
      : null;

  return { id, label, name, path: resource.path, parentId };
}

function distinctNodes(records: readonly GraphReadRecord[], scope: ReadScope): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  for (const record of records) {
    const node = mapNode(record, scope);
    if (node) nodes.set(node.id, node);
  }
  return [...nodes.values()];
}

function isStructuralEdgeType(value: string | null): value is StructuralEdgeType {
  return value === 'CONTAINS' || value === 'IMPORTS';
}

function scopeParameters(scope: ReadScope): Record<string, unknown> {
  return {
    allow_rules: cypherRules(scope.allows),
    deny_rules: cypherRules(scope.denies),
  };
}

export class RbacGraphQueryService
  implements GraphQueryService, StyleRuleGraphQueryService
{
  constructor(
    private readonly graph: GraphReadExecutor,
    private readonly permissions: PermissionStore,
  ) {}

  async getNodesInViewport(
    repoId: string,
    viewport: Viewport,
    ctx: AuthContext,
  ): Promise<GraphNode[]> {
    if (!repoId.trim()) return [];
    const scope = await this.permissions.getReadScope(ctx, repoId);
    if (scope.allows.length === 0) return [];

    const worldWidth = viewport.width / viewport.zoom;
    const worldHeight = viewport.height / viewport.zoom;
    const viewportMaxX = viewport.x + worldWidth;
    const viewportMaxY = viewport.y + worldHeight;
    if (
      ![viewport.x, viewport.y, worldWidth, worldHeight, viewportMaxX, viewportMaxY].every(
        Number.isFinite,
      ) ||
      worldWidth <= 0 ||
      worldHeight <= 0
    ) {
      throw new RangeError('Viewport must contain finite coordinates and positive dimensions.');
    }

    const result = await this.graph.run(ctx.orgId, 'viewport_read', GET_NODES_IN_VIEWPORT_CYPHER, {
      org_id: ctx.orgId,
      repo_id: repoId,
      viewport_min_x: viewport.x,
      viewport_max_x: viewportMaxX,
      viewport_min_y: viewport.y,
      viewport_max_y: viewportMaxY,
      ...scopeParameters(scope),
    });
    return distinctNodes(result.records, scope);
  }

  async getStructuralEdges(
    nodeIds: readonly string[],
    ctx: AuthContext,
  ): Promise<GraphEdge[]> {
    const ids = [...new Set(nodeIds.filter((id) => id.trim().length > 0))];
    if (ids.length === 0) return [];
    const scope = await this.permissions.getReadScope(ctx);
    if (scope.allows.length === 0) return [];

    const result = await this.graph.run(ctx.orgId, 'traversal', GET_STRUCTURAL_EDGES_CYPHER, {
      org_id: ctx.orgId,
      node_ids: ids,
      ...scopeParameters(scope),
    });

    const requested = new Set(ids);
    const edges = new Map<string, GraphEdge>();
    for (const record of result.records) {
      const type = valueAsString(record, 'type');
      const source = valueAsString(record, 'source_id');
      const target = valueAsString(record, 'target_id');
      const sourceResource = resourceFromRecord(record, 'source_');
      const targetResource = resourceFromRecord(record, 'target_');
      if (
        !isStructuralEdgeType(type) ||
        !source ||
        !target ||
        !requested.has(source) ||
        !requested.has(target) ||
        !sourceResource ||
        !targetResource ||
        sourceResource.repoId !== targetResource.repoId ||
        sourceResource.refName !== targetResource.refName ||
        !canReadResource(scope, sourceResource) ||
        !canReadResource(scope, targetResource)
      ) {
        continue;
      }

      const id = `${type}:${source}:${target}`;
      edges.set(id, { id, type, source, target });
    }
    return [...edges.values()];
  }

  async getAffectedNodes(
    repoId: string,
    paths: readonly string[],
    ctx: AuthContext,
  ): Promise<AffectedNodes> {
    const distinctPaths = [...new Set(paths.filter((path) => path.length > 0))];
    if (!repoId.trim() || distinctPaths.length === 0) return { visible: [], removed: [] };
    const scope = await this.permissions.getReadScope(ctx, repoId);
    if (scope.allows.length === 0) return { visible: [], removed: [] };

    const result = await this.graph.run(ctx.orgId, 'traversal', GET_AFFECTED_NODES_CYPHER, {
      org_id: ctx.orgId,
      repo_id: repoId,
      paths: distinctPaths,
      ...scopeParameters(scope),
    });

    // Absence alone cannot distinguish deletion from an unauthorized path.
    // Itemized removals therefore stay empty until an authorization-aware
    // deletion ledger exists; the realtime gateway already uses graph.resync.
    return { visible: distinctNodes(result.records, scope), removed: [] };
  }

  async resolveStyleRules(
    nodeId: string,
    ctx: AuthContext,
  ): Promise<ResolvedStyleRules | null> {
    const requestedNodeId = nodeId.trim();
    if (
      requestedNodeId.length === 0 ||
      requestedNodeId.length > 512 ||
      requestedNodeId !== nodeId
    ) {
      return null;
    }
    const scope = await this.permissions.getReadScope(ctx);
    if (scope.allows.length === 0) return null;

    const result = await this.graph.run(ctx.orgId, 'traversal', RESOLVE_STYLE_RULES_CYPHER, {
      org_id: ctx.orgId,
      node_id: requestedNodeId,
      ...scopeParameters(scope),
    });
    return resolveStyleRecords(result.records, requestedNodeId, ctx.orgId, scope);
  }
}

export const graphQueryService: GraphQueryService & StyleRuleGraphQueryService =
  new RbacGraphQueryService(
    new LazyGraphReadExecutor(),
    new PostgresPermissionStore(),
  );

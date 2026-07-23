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

export class RbacGraphQueryService implements GraphQueryService {
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
}

export const graphQueryService: GraphQueryService = new RbacGraphQueryService(
  new LazyGraphReadExecutor(),
  new PostgresPermissionStore(),
);

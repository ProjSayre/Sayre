import type { AuthContext } from '../auth/context';
import {
  LazyGraphReadExecutor,
  toNeo4jInt,
  type GraphReadExecutor,
  type GraphReadRecord,
} from './neo4j';
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
  CoverageBadge,
  CoverageBadgeStatus,
  FeatureCluster,
  FeatureMember,
  FeatureRecentEdit,
  GraphEdge,
  GraphNode,
  GraphQueryService,
  NodeOverlayGraphQueryService,
  NodeOverlayGraphSnapshot,
  OverlayDependency,
  OverlayFeature,
  OverlayRecentChange,
  OverlayTicket,
  OnboardingGraphProjection,
  OnboardingGraphQueryService,
  OnboardingGraphStep,
  ResolvedStyleRules,
  ResolvedStyleValue,
  StyleRuleGraphQueryService,
  RetrievalGraphNode,
  RetrievalGraphQueryService,
  RetrievalTraversal,
  StructuralEdgeType,
  Viewport,
} from './types';
import { canonicalRefName } from '../refName';
import {
  canonicalRelativePath,
  MAX_GRAPH_PATH_LENGTH,
} from './path';

export * from './types';
export {
  PostgresPermissionStore,
  canReadResource,
  type AuthorizationRule,
  type PermissionStore,
  type ReadScope,
} from './permissions';

function canonicalGraphPathPredicate(variable: string): string {
  return `${variable}.path IS NOT NULL
  AND size(${variable}.path) <= ${MAX_GRAPH_PATH_LENGTH}
  AND NOT (${variable}.path STARTS WITH '/')
  AND NOT (${variable}.path ENDS WITH '/')
  AND NOT (${variable}.path CONTAINS '//')
  AND NOT (${variable}.path CONTAINS '\\\\')
  AND NOT (('/' + ${variable}.path + '/') CONTAINS '/../')
  AND NOT (('/' + ${variable}.path + '/') CONTAINS '/./')`;
}

// Permission predicates intentionally run inside the graph query so hidden
// nodes do not cross the graph-store boundary. The TypeScript mapper repeats
// the same decision as defense in depth before returning any record.
export const GET_NODES_IN_VIEWPORT_CYPHER = `
MATCH (node)
WHERE (node:Folder OR node:File)
  AND node.org_id = $org_id
  AND node.repo_id = $repo_id
  AND node.ref_name = $ref_name
  AND node.uid IS NOT NULL
  AND node.name IS NOT NULL
  AND ${canonicalGraphPathPredicate('node')}
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
  AND parent.ref_name = $ref_name
  AND parent.ref_name = node.ref_name
  AND parent_edge.org_id = $org_id
  AND ${canonicalGraphPathPredicate('parent')}
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
OPTIONAL MATCH (test:Test)-[coverage:COVERS]->(node)
WHERE node:File
  AND test.org_id = $org_id
  AND coverage.org_id = $org_id
  AND test.repo_id = node.repo_id
  AND test.ref_name = node.ref_name
  AND test.revision_sha = node.revision_sha
  AND coverage.repo_id = node.repo_id
  AND coverage.ref_name = node.ref_name
  AND coverage.revision_sha = node.revision_sha
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = test.repo_id) AND
    (rule.branch IS NULL OR rule.branch = test.ref_name) AND
    (rule.path_prefix IS NULL OR test.path = rule.path_prefix OR
      test.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = test.repo_id) AND
    (rule.branch IS NULL OR rule.branch = test.ref_name) AND
    (rule.path_prefix IS NULL OR test.path = rule.path_prefix OR
      test.path STARTS WITH rule.path_prefix + '/'))
RETURN node.uid AS id,
       CASE WHEN node:Folder THEN 'Folder' ELSE 'File' END AS label,
       node.name AS name,
       node.path AS path,
       node.repo_id AS repo_id,
       node.ref_name AS ref_name,
       parent.uid AS parent_id,
       parent.path AS parent_path,
       parent.repo_id AS parent_repo_id,
       parent.ref_name AS parent_ref_name,
       node.last_edited_at AS node_last_edited_at,
       node.last_structural_change_at AS node_last_structural_change_at,
       test.coverage_status AS coverage_test_status,
       coverage.status AS coverage_edge_status,
       coverage.last_run AS coverage_last_run
ORDER BY node.path, node.uid
`;

export const GET_STRUCTURAL_EDGES_CYPHER = `
MATCH (source)-[edge]->(target)
WHERE source.org_id = $org_id
  AND target.org_id = $org_id
  AND edge.org_id = $org_id
  AND source.uid IN $node_ids
  AND target.uid IN $node_ids
  AND source.repo_id = $repo_id
  AND target.repo_id = $repo_id
  AND source.ref_name = $ref_name
  AND target.ref_name = $ref_name
  AND (source:Folder OR source:File)
  AND (target:Folder OR target:File)
  AND ${canonicalGraphPathPredicate('source')}
  AND ${canonicalGraphPathPredicate('target')}
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
  AND ${canonicalGraphPathPredicate('node')}
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
  AND ${canonicalGraphPathPredicate('parent')}
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
  AND ${canonicalGraphPathPredicate('target')}
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
    ${canonicalGraphPathPredicate('path_node')} AND
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

// Anchor matching is deliberately lexical and graph-local. Vector similarity
// happens only after the authorized graph neighborhood is known; searching
// vectors first would create a parallel authorization path.
export const RESOLVE_RETRIEVAL_ANCHORS_CYPHER = `
MATCH (node)
WHERE (node:Folder OR node:File)
  AND node.org_id = $org_id
  AND node.uid IS NOT NULL
  AND node.name IS NOT NULL
  AND ${canonicalGraphPathPredicate('node')}
  AND node.repo_id IS NOT NULL
  AND node.ref_name IS NOT NULL
  AND node.revision_sha IS NOT NULL
  AND (
    ($exact_node_id IS NOT NULL AND node.uid = $exact_node_id) OR
    ($exact_node_id IS NULL AND ANY(term IN $query_terms WHERE
      toLower(node.name) CONTAINS term OR toLower(node.path) CONTAINS term))
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
WITH node,
     CASE
       WHEN $exact_node_id IS NOT NULL THEN 1000
       WHEN toLower(node.path) = $normalized_query THEN 100
       WHEN toLower(node.name) = $normalized_query THEN 90
       ELSE size([term IN $query_terms WHERE
         toLower(node.name) CONTAINS term OR toLower(node.path) CONTAINS term])
     END AS relevance
ORDER BY relevance DESC, node.path, node.uid
LIMIT $limit
RETURN node.uid AS id,
       CASE WHEN node:Folder THEN 'Folder' ELSE 'File' END AS label,
       node.name AS name,
       node.path AS path,
       node.org_id AS org_id,
       node.repo_id AS repo_id,
       node.ref_name AS ref_name,
       node.revision_sha AS revision_sha,
       0 AS distance
`;

// Structural traversal is capped in the query itself at two hops. The smaller
// runtime max_hops parameter can tighten that cap but can never expand it.
// Every path node is independently RBAC-filtered, so an allowed endpoint cannot
// be reached through a hidden intermediate node.
export const TRAVERSE_RETRIEVAL_CONTEXT_CYPHER = `
MATCH (anchor)
WHERE (anchor:Folder OR anchor:File)
  AND anchor.org_id = $org_id
  AND anchor.uid = $anchor_id
  AND ${canonicalGraphPathPredicate('anchor')}
  AND anchor.repo_id IS NOT NULL
  AND anchor.ref_name IS NOT NULL
  AND anchor.revision_sha IS NOT NULL
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = anchor.repo_id) AND
    (rule.branch IS NULL OR rule.branch = anchor.ref_name) AND
    (rule.path_prefix IS NULL OR anchor.path = rule.path_prefix OR
      anchor.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = anchor.repo_id) AND
    (rule.branch IS NULL OR rule.branch = anchor.ref_name) AND
    (rule.path_prefix IS NULL OR anchor.path = rule.path_prefix OR
      anchor.path STARTS WITH rule.path_prefix + '/'))
MATCH path = (anchor)-[*0..2]-(node)
WHERE length(path) <= $max_hops
  AND (node:Folder OR node:File)
  AND node.org_id = $org_id
  AND node.repo_id = anchor.repo_id
  AND node.ref_name = anchor.ref_name
  AND node.revision_sha = anchor.revision_sha
  AND node.uid IS NOT NULL
  AND node.name IS NOT NULL
  AND ${canonicalGraphPathPredicate('node')}
  AND ALL(edge IN relationships(path) WHERE
    type(edge) IN ['CONTAINS', 'IMPORTS'] AND edge.org_id = $org_id)
  AND ALL(path_node IN nodes(path) WHERE
    (path_node:Folder OR path_node:File) AND
    path_node.org_id = $org_id AND
    path_node.repo_id = anchor.repo_id AND
    path_node.ref_name = anchor.ref_name AND
    path_node.revision_sha = anchor.revision_sha AND
    ${canonicalGraphPathPredicate('path_node')} AND
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
WITH anchor, node, min(length(path)) AS distance,
     size([term IN $intent_terms WHERE
       toLower(node.name) CONTAINS term OR toLower(node.path) CONTAINS term]) AS relevance
ORDER BY CASE WHEN node.uid = anchor.uid THEN 0 ELSE 1 END,
         relevance DESC,
         distance,
         node.path,
         node.uid
LIMIT $limit
RETURN anchor.uid AS anchor_id,
       CASE WHEN anchor:Folder THEN 'Folder' ELSE 'File' END AS anchor_label,
       anchor.name AS anchor_name,
       anchor.path AS anchor_path,
       anchor.org_id AS anchor_org_id,
       anchor.repo_id AS anchor_repo_id,
       anchor.ref_name AS anchor_ref_name,
       anchor.revision_sha AS anchor_revision_sha,
       node.uid AS id,
       CASE WHEN node:Folder THEN 'Folder' ELSE 'File' END AS label,
       node.name AS name,
       node.path AS path,
       node.org_id AS org_id,
       node.repo_id AS repo_id,
       node.ref_name AS ref_name,
       node.revision_sha AS revision_sha,
       distance
`;

export const GET_FEATURE_CLUSTERS_CYPHER = `
MATCH (root:Folder {
  org_id: $org_id,
  repo_id: $repo_id,
  ref_name: $ref_name,
  path: ''
})
WHERE root.revision_sha IS NOT NULL
MATCH (member:File)-[membership:PART_OF]->(feature:Feature)
WHERE member.org_id = $org_id
  AND feature.org_id = $org_id
  AND membership.org_id = $org_id
  AND member.repo_id = $repo_id
  AND feature.repo_id = $repo_id
  AND member.ref_name = $ref_name
  AND feature.ref_name = $ref_name
  AND member.revision_sha = root.revision_sha
  AND feature.revision_sha = root.revision_sha
  AND member.uid IS NOT NULL
  AND member.name IS NOT NULL
  AND ${canonicalGraphPathPredicate('member')}
  AND feature.uid IS NOT NULL
  AND feature.name IS NOT NULL
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = member.repo_id) AND
    (rule.branch IS NULL OR rule.branch = member.ref_name) AND
    (rule.path_prefix IS NULL OR member.path = rule.path_prefix OR
      member.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = member.repo_id) AND
    (rule.branch IS NULL OR rule.branch = member.ref_name) AND
    (rule.path_prefix IS NULL OR member.path = rule.path_prefix OR
      member.path STARTS WITH rule.path_prefix + '/'))
RETURN root.org_id AS root_org_id,
       root.revision_sha AS current_revision_sha,
       feature.org_id AS feature_org_id,
       feature.repo_id AS feature_repo_id,
       feature.ref_name AS feature_ref_name,
       feature.revision_sha AS feature_revision_sha,
       feature.uid AS feature_id,
       feature.name AS feature_name,
       feature.description AS feature_description,
       feature.team AS feature_team,
       membership.org_id AS membership_org_id,
       member.org_id AS member_org_id,
       member.repo_id AS member_repo_id,
       member.ref_name AS member_ref_name,
       member.revision_sha AS member_revision_sha,
       member.uid AS member_id,
       'File' AS member_label,
       member.name AS member_name,
       member.path AS member_path,
       member.last_edited_at AS member_last_edited_at,
       member.primary_owner_name AS member_editor_name,
       member.primary_owner_login AS member_editor_login,
       member.recent_pr_title AS member_recent_pr_title,
       member.recent_pr_url AS member_recent_pr_url
ORDER BY feature.name, feature.uid, member.path, member.uid
`;

/**
 * One graph round-trip supplies every graph-backed overlay layer. Optional
 * matches can form a cross product, so the mapper below de-duplicates every
 * layer and this query applies a hard row cap. Visibility predicates are
 * repeated for both dependency endpoints; hidden neighbors never leave the
 * graph store.
 */
export const GET_NODE_OVERLAY_CYPHER = `
MATCH (target)
WHERE (target:Folder OR target:File)
  AND target.org_id = $org_id
  AND target.uid = $node_id
  AND target.name IS NOT NULL
  AND target.path IS NOT NULL
  AND target.repo_id IS NOT NULL
  AND target.ref_name IS NOT NULL
  AND target.revision_sha IS NOT NULL
  AND ${canonicalGraphPathPredicate('target')}
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
OPTIONAL MATCH (target)-[out_import:IMPORTS]->(out_dependency)
WHERE (out_dependency:Folder OR out_dependency:File)
  AND out_import.org_id = $org_id
  AND out_dependency.org_id = $org_id
  AND out_dependency.repo_id = target.repo_id
  AND out_dependency.ref_name = target.ref_name
  AND out_dependency.revision_sha = target.revision_sha
  AND out_dependency.uid IS NOT NULL
  AND out_dependency.name IS NOT NULL
  AND ${canonicalGraphPathPredicate('out_dependency')}
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = out_dependency.repo_id) AND
    (rule.branch IS NULL OR rule.branch = out_dependency.ref_name) AND
    (rule.path_prefix IS NULL OR out_dependency.path = rule.path_prefix OR
      out_dependency.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = out_dependency.repo_id) AND
    (rule.branch IS NULL OR rule.branch = out_dependency.ref_name) AND
    (rule.path_prefix IS NULL OR out_dependency.path = rule.path_prefix OR
      out_dependency.path STARTS WITH rule.path_prefix + '/'))
OPTIONAL MATCH (in_dependency)-[in_import:IMPORTS]->(target)
WHERE (in_dependency:Folder OR in_dependency:File)
  AND in_import.org_id = $org_id
  AND in_dependency.org_id = $org_id
  AND in_dependency.repo_id = target.repo_id
  AND in_dependency.ref_name = target.ref_name
  AND in_dependency.revision_sha = target.revision_sha
  AND in_dependency.uid IS NOT NULL
  AND in_dependency.name IS NOT NULL
  AND ${canonicalGraphPathPredicate('in_dependency')}
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = in_dependency.repo_id) AND
    (rule.branch IS NULL OR rule.branch = in_dependency.ref_name) AND
    (rule.path_prefix IS NULL OR in_dependency.path = rule.path_prefix OR
      in_dependency.path STARTS WITH rule.path_prefix + '/'))
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = in_dependency.repo_id) AND
    (rule.branch IS NULL OR rule.branch = in_dependency.ref_name) AND
    (rule.path_prefix IS NULL OR in_dependency.path = rule.path_prefix OR
      in_dependency.path STARTS WITH rule.path_prefix + '/'))
OPTIONAL MATCH (commit:Commit)-[modified:MODIFIED]->(target)
WHERE commit.org_id = $org_id
  AND commit.repository_id = target.repo_id
  AND commit.ref_name = target.ref_name
  AND modified.org_id = $org_id
OPTIONAL MATCH (author:Person)-[authored:AUTHORED]->(commit)
WHERE author.org_id = $org_id
  AND authored.org_id = $org_id
OPTIONAL MATCH (target)-[membership:PART_OF]->(feature:Feature)
WHERE membership.org_id = $org_id
  AND feature.org_id = $org_id
  AND feature.repo_id = target.repo_id
  AND feature.ref_name = target.ref_name
  AND feature.revision_sha = target.revision_sha
OPTIONAL MATCH (ticket:Ticket)-[reference:REFERENCES]->(target)
WHERE ticket.org_id = $org_id
  AND reference.org_id = $org_id
  AND ticket.repo_id = target.repo_id
  AND ticket.ref_name = target.ref_name
RETURN target.uid AS target_id,
       CASE WHEN target:Folder THEN 'Folder' ELSE 'File' END AS target_label,
       target.name AS target_name,
       target.path AS target_path,
       target.org_id AS target_org_id,
       target.repo_id AS target_repo_id,
       target.ref_name AS target_ref_name,
       target.revision_sha AS target_revision_sha,
       target.description AS target_description,
       out_dependency.uid AS out_dependency_id,
       CASE
         WHEN out_dependency:Folder THEN 'Folder'
         WHEN out_dependency:File THEN 'File'
         ELSE NULL
       END AS out_dependency_label,
       out_dependency.name AS out_dependency_name,
       out_dependency.path AS out_dependency_path,
       out_dependency.org_id AS out_dependency_org_id,
       out_dependency.repo_id AS out_dependency_repo_id,
       out_dependency.ref_name AS out_dependency_ref_name,
       out_dependency.revision_sha AS out_dependency_revision_sha,
       in_dependency.uid AS in_dependency_id,
       CASE
         WHEN in_dependency:Folder THEN 'Folder'
         WHEN in_dependency:File THEN 'File'
         ELSE NULL
       END AS in_dependency_label,
       in_dependency.name AS in_dependency_name,
       in_dependency.path AS in_dependency_path,
       in_dependency.org_id AS in_dependency_org_id,
       in_dependency.repo_id AS in_dependency_repo_id,
       in_dependency.ref_name AS in_dependency_ref_name,
       in_dependency.revision_sha AS in_dependency_revision_sha,
       commit.uid AS commit_id,
       commit.org_id AS commit_org_id,
       commit.repository_id AS commit_repository_id,
       commit.ref_name AS commit_ref_name,
       commit.sha AS commit_sha,
       commit.message AS commit_message,
       coalesce(modified.timestamp, commit.timestamp) AS commit_timestamp,
       author.name AS author_name,
       author.provider_login AS author_login,
       author.org_id AS author_org_id,
       authored.org_id AS authored_org_id,
       modified.org_id AS modified_org_id,
       target.recent_pr_title AS recent_pr_title,
       target.recent_pr_url AS recent_pr_url,
       feature.uid AS feature_id,
       feature.name AS feature_name,
       feature.description AS feature_description,
       feature.team AS feature_team,
       feature.org_id AS feature_org_id,
       feature.repo_id AS feature_repo_id,
       feature.ref_name AS feature_ref_name,
       feature.revision_sha AS feature_revision_sha,
       membership.org_id AS membership_org_id,
       ticket.uid AS ticket_id,
       ticket.external_id AS ticket_external_id,
       ticket.system AS ticket_system,
       ticket.title AS ticket_title,
       ticket.status AS ticket_status,
       ticket.url AS ticket_url,
       ticket.org_id AS ticket_org_id,
       ticket.repo_id AS ticket_repo_id,
       ticket.ref_name AS ticket_ref_name,
       reference.org_id AS reference_org_id
ORDER BY commit_timestamp DESC, feature_name, ticket_external_id
LIMIT 512
`;

export const GET_ONBOARDING_STEPS_CYPHER = `
MATCH (root:Folder {
  org_id: $org_id,
  repo_id: $repo_id,
  ref_name: $ref_name,
  path: ''
})
WHERE root.revision_sha IS NOT NULL
  AND root.uid IS NOT NULL
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = root.repo_id) AND
    (rule.branch IS NULL OR rule.branch = root.ref_name) AND
    rule.path_prefix IS NULL)
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = root.repo_id) AND
    (rule.branch IS NULL OR rule.branch = root.ref_name) AND
    rule.path_prefix IS NULL)
OPTIONAL MATCH (step:EnvStep {
  org_id: $org_id,
  repo_id: $repo_id,
  ref_name: $ref_name,
  revision_sha: root.revision_sha
})
WHERE step.uid IS NOT NULL
  AND step.sequence IS NOT NULL
  AND step.command IS NOT NULL
OPTIONAL MATCH (step)-[requires:REQUIRES]->(prerequisite:EnvStep)
WHERE requires.org_id = $org_id
  AND prerequisite.org_id = $org_id
  AND prerequisite.repo_id = $repo_id
  AND prerequisite.ref_name = $ref_name
  AND prerequisite.revision_sha = root.revision_sha
RETURN root.org_id AS root_org_id,
       root.repo_id AS root_repo_id,
       root.ref_name AS root_ref_name,
       root.revision_sha AS root_revision_sha,
       step.org_id AS step_org_id,
       step.repo_id AS step_repo_id,
       step.ref_name AS step_ref_name,
       step.revision_sha AS step_revision_sha,
       step.uid AS step_id,
       step.sequence AS step_sequence,
       step.command AS step_command,
       collect(DISTINCT prerequisite.uid) AS prerequisite_ids
ORDER BY step.sequence, step.uid
`;

export const GET_ONBOARDING_CANVAS_NODES_CYPHER = `
MATCH (root:Folder {
  org_id: $org_id,
  repo_id: $repo_id,
  ref_name: $ref_name,
  path: ''
})
WHERE root.revision_sha = $revision_sha
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = root.repo_id) AND
    (rule.branch IS NULL OR rule.branch = root.ref_name) AND
    rule.path_prefix IS NULL)
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = root.repo_id) AND
    (rule.branch IS NULL OR rule.branch = root.ref_name) AND
    rule.path_prefix IS NULL)
MATCH (node)
WHERE (node:Folder OR node:File)
  AND node.org_id = $org_id
  AND node.repo_id = $repo_id
  AND node.ref_name = $ref_name
  AND node.revision_sha = root.revision_sha
  AND node.uid IS NOT NULL
  AND node.name IS NOT NULL
  AND node.path IS NOT NULL
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
  AND parent.repo_id = $repo_id
  AND parent.ref_name = $ref_name
  AND parent.revision_sha = root.revision_sha
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
RETURN root.revision_sha AS root_revision_sha,
       node.uid AS id,
       CASE WHEN node:Folder THEN 'Folder' ELSE 'File' END AS label,
       node.name AS name,
       node.path AS path,
       node.org_id AS org_id,
       node.repo_id AS repo_id,
       node.ref_name AS ref_name,
       node.revision_sha AS revision_sha,
       parent.uid AS parent_id,
       parent.org_id AS parent_org_id,
       parent.repo_id AS parent_repo_id,
       parent.ref_name AS parent_ref_name,
       parent.path AS parent_path,
       parent.revision_sha AS parent_revision_sha
ORDER BY node.path, node.uid
`;

function valueAsString(record: GraphReadRecord, key: string): string | null {
  const value = record.get(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function valueAsOptionalString(record: GraphReadRecord, key: string): string | null {
  const value = record.get(key);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function valueAsCanonicalPath(
  record: GraphReadRecord,
  key: string,
): string | null {
  return canonicalRelativePath(record.get(key));
}

function resourceFromRecord(
  record: GraphReadRecord,
  prefix = '',
): ScopedGraphResource | null {
  const repoId = valueAsString(record, `${prefix}repo_id`);
  const refName = valueAsString(record, `${prefix}ref_name`);
  const path = valueAsCanonicalPath(record, `${prefix}path`);
  return repoId && refName && path !== null ? { repoId, refName, path } : null;
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
  const path = valueAsCanonicalPath(record, `${prefix}path`);
  return orgId && repoId && refName && revisionSha && path !== null
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

function mapNode(
  record: GraphReadRecord,
  scope: ReadScope,
  expected?: { repoId: string; refName: string },
): GraphNode | null {
  const id = valueAsString(record, 'id');
  const label = valueAsString(record, 'label');
  const name = valueAsString(record, 'name');
  const resource = resourceFromRecord(record);
  if (
    !id ||
    !isCanvasLabel(label) ||
    !name ||
    !resource ||
    (expected !== undefined &&
      (resource.repoId !== expected.repoId ||
        resource.refName !== expected.refName))
  ) {
    return null;
  }
  if (!canReadResource(scope, resource)) return null;

  const rawParentId = valueAsString(record, 'parent_id');
  const parentResource = resourceFromRecord(record, 'parent_');
  const parentId =
    rawParentId &&
    parentResource &&
    (expected === undefined ||
      (parentResource.repoId === expected.repoId &&
        parentResource.refName === expected.refName)) &&
    canReadResource(scope, parentResource)
      ? rawParentId
      : null;

  return { id, label, name, path: resource.path, parentId };
}

function distinctNodes(
  records: readonly GraphReadRecord[],
  scope: ReadScope,
  expected?: { repoId: string; refName: string },
): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  for (const record of records) {
    const node = mapNode(record, scope, expected);
    if (node) nodes.set(node.id, node);
  }
  return [...nodes.values()];
}

const COVERAGE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1_000;

function valueAsTimestamp(record: GraphReadRecord, key: string): string | null {
  const value = record.get(key);
  const candidate =
    typeof value === 'string'
      ? value
      : value !== null &&
          typeof value === 'object' &&
          value.constructor?.name !== 'Object' &&
          typeof value.toString === 'function'
        ? value.toString()
        : null;
  if (candidate === null || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
}

function coverageObservation(
  record: GraphReadRecord,
  nowMs: number,
): CoverageBadge | null {
  const edgeStatus = valueAsOptionalString(record, 'coverage_edge_status');
  if (edgeStatus !== 'inferred' && edgeStatus !== 'measured') return null;

  const testStatus = valueAsOptionalString(record, 'coverage_test_status');
  const lastRun = valueAsTimestamp(record, 'coverage_last_run');
  const lastEditedAt = valueAsTimestamp(record, 'node_last_edited_at');
  const lastStructuralChangeAt = valueAsTimestamp(
    record,
    'node_last_structural_change_at',
  );
  const lastRunMs = lastRun === null ? null : Date.parse(lastRun);
  const changedAtMs = Math.max(
    lastEditedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(lastEditedAt),
    lastStructuralChangeAt === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(lastStructuralChangeAt),
  );
  const stale =
    lastRunMs === null ||
    nowMs - lastRunMs > COVERAGE_FRESHNESS_MS ||
    changedAtMs > lastRunMs;

  let status: CoverageBadgeStatus = 'unknown';
  if (testStatus === 'fail') status = 'fail';
  else if (stale) status = 'stale';
  else if (testStatus === 'pass') status = 'pass';

  return { status, lastRun, coveringTests: 1 };
}

const COVERAGE_PRIORITY: Readonly<Record<CoverageBadgeStatus, number>> = {
  pass: 0,
  unknown: 1,
  stale: 2,
  fail: 3,
};

function mergeCoverage(left: CoverageBadge, right: CoverageBadge): CoverageBadge {
  const status =
    COVERAGE_PRIORITY[right.status] > COVERAGE_PRIORITY[left.status]
      ? right.status
      : left.status;
  const lastRun =
    left.lastRun === null
      ? right.lastRun
      : right.lastRun === null || Date.parse(left.lastRun) >= Date.parse(right.lastRun)
        ? left.lastRun
        : right.lastRun;
  return {
    status,
    lastRun,
    coveringTests: left.coveringTests + right.coveringTests,
  };
}

function distinctViewportNodes(
  records: readonly GraphReadRecord[],
  scope: ReadScope,
  nowMs: number,
  expected: { repoId: string; refName: string },
): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  for (const record of records) {
    const node = mapNode(record, scope, expected);
    if (!node) continue;
    if (node.label === 'Folder') {
      nodes.set(node.id, node);
      continue;
    }

    const observation = coverageObservation(record, nowMs);
    const coverage = observation ?? {
      status: 'unknown' as const,
      lastRun: null,
      coveringTests: 0,
    };
    const existing = nodes.get(node.id);
    nodes.set(node.id, {
      ...node,
      coverage:
        existing?.coverage && observation
          ? mergeCoverage(existing.coverage, observation)
          : existing?.coverage ?? coverage,
    });
  }
  return [...nodes.values()];
}

function valueAsSafeDistance(record: GraphReadRecord, key: string): number | null {
  const raw = record.get(key);
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'toNumber' in raw &&
    typeof (raw as { toNumber?: unknown }).toNumber === 'function'
  ) {
    const converted = (raw as { toNumber(): number }).toNumber();
    return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
  }
  return null;
}

function mapRetrievalNode(
  record: GraphReadRecord,
  scope: ReadScope,
  expectedOrgId: string,
  prefix = '',
): RetrievalGraphNode | null {
  const id = valueAsString(record, `${prefix}id`);
  const label = valueAsString(record, `${prefix}label`);
  const name = valueAsString(record, `${prefix}name`);
  const path = valueAsCanonicalPath(record, `${prefix}path`);
  const orgId = valueAsString(record, `${prefix}org_id`);
  const repoId = valueAsString(record, `${prefix}repo_id`);
  const refName = valueAsString(record, `${prefix}ref_name`);
  const revisionSha = valueAsString(record, `${prefix}revision_sha`);
  const distance = prefix ? 0 : valueAsSafeDistance(record, 'distance');
  if (
    !id ||
    !isCanvasLabel(label) ||
    !name ||
    path === null ||
    orgId !== expectedOrgId ||
    !repoId ||
    !refName ||
    !revisionSha ||
    distance === null
  ) {
    return null;
  }

  const resource = { repoId, refName, path };
  if (!canReadResource(scope, resource)) return null;
  return {
    id,
    label,
    name,
    path,
    repositoryId: repoId,
    refName,
    revisionSha,
    distance,
  };
}

interface FeatureRow {
  cluster: Omit<FeatureCluster, 'members'>;
  member: FeatureMember;
}

function safeWebUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

function mapFeatureRow(
  record: GraphReadRecord,
  scope: ReadScope,
  requested: { orgId: string; repoId: string; refName: string },
): FeatureRow | null {
  const currentRevisionSha = valueAsString(record, 'current_revision_sha');
  const featureRevisionSha = valueAsString(record, 'feature_revision_sha');
  const memberRevisionSha = valueAsString(record, 'member_revision_sha');
  if (
    valueAsString(record, 'root_org_id') !== requested.orgId ||
    valueAsString(record, 'feature_org_id') !== requested.orgId ||
    valueAsString(record, 'membership_org_id') !== requested.orgId ||
    valueAsString(record, 'member_org_id') !== requested.orgId ||
    valueAsString(record, 'feature_repo_id') !== requested.repoId ||
    valueAsString(record, 'feature_ref_name') !== requested.refName ||
    !currentRevisionSha ||
    featureRevisionSha !== currentRevisionSha ||
    memberRevisionSha !== currentRevisionSha
  ) {
    return null;
  }

  const featureId = valueAsString(record, 'feature_id');
  const featureName = valueAsOptionalString(record, 'feature_name');
  const memberId = valueAsString(record, 'member_id');
  const memberLabel = valueAsString(record, 'member_label');
  const memberName = valueAsOptionalString(record, 'member_name');
  const memberResource = resourceFromRecord(record, 'member_');
  if (
    !featureId ||
    !featureName ||
    !memberId ||
    memberLabel !== 'File' ||
    !memberName ||
    !memberResource ||
    memberResource.repoId !== requested.repoId ||
    memberResource.refName !== requested.refName ||
    !canReadResource(scope, memberResource)
  ) {
    return null;
  }

  const editedAt = valueAsOptionalString(record, 'member_last_edited_at');
  const recentEdit: FeatureRecentEdit | null =
    editedAt !== null && Number.isFinite(Date.parse(editedAt))
      ? {
          fileId: memberId,
          filePath: memberResource.path,
          editedAt,
          editorName: valueAsOptionalString(record, 'member_editor_name'),
          editorLogin: valueAsOptionalString(record, 'member_editor_login'),
          pullRequestTitle: valueAsOptionalString(record, 'member_recent_pr_title'),
          pullRequestUrl: safeWebUrl(
            valueAsOptionalString(record, 'member_recent_pr_url'),
          ),
        }
      : null;

  return {
    cluster: {
      id: featureId,
      name: featureName,
      description: valueAsOptionalString(record, 'feature_description'),
      team: valueAsOptionalString(record, 'feature_team'),
      revisionSha: currentRevisionSha,
    },
    member: {
      id: memberId,
      label: 'File',
      name: memberName,
      path: memberResource.path,
      parentId: null,
      recentEdit,
    },
  };
}

function featureMetadataKey(cluster: Omit<FeatureCluster, 'members'>): string {
  return JSON.stringify([
    cluster.name,
    cluster.description,
    cluster.team,
    cluster.revisionSha,
  ]);
}

function featureMemberKey(member: FeatureMember): string {
  return JSON.stringify([
    member.label,
    member.name,
    member.path,
    member.recentEdit,
  ]);
}

function distinctFeatureClusters(
  records: readonly GraphReadRecord[],
  scope: ReadScope,
  requested: { orgId: string; repoId: string; refName: string },
): FeatureCluster[] {
  const clusters = new Map<
    string,
    Omit<FeatureCluster, 'members'> & { members: Map<string, FeatureMember> }
  >();
  const invalidClusters = new Set<string>();

  for (const record of records) {
    const row = mapFeatureRow(record, scope, requested);
    if (row === null || invalidClusters.has(row.cluster.id)) continue;

    const existing = clusters.get(row.cluster.id);
    if (existing === undefined) {
      clusters.set(row.cluster.id, {
        ...row.cluster,
        members: new Map([[row.member.id, row.member]]),
      });
      continue;
    }

    if (featureMetadataKey(existing) !== featureMetadataKey(row.cluster)) {
      clusters.delete(row.cluster.id);
      invalidClusters.add(row.cluster.id);
      continue;
    }

    const existingMember = existing.members.get(row.member.id);
    if (
      existingMember !== undefined &&
      featureMemberKey(existingMember) !== featureMemberKey(row.member)
    ) {
      clusters.delete(row.cluster.id);
      invalidClusters.add(row.cluster.id);
      continue;
    }
    existing.members.set(row.member.id, row.member);
  }

  return [...clusters.values()]
    .map(({ members, ...cluster }) => ({
      ...cluster,
      members: [...members.values()].sort(
        (a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id),
      ),
    }))
    .filter((cluster) => cluster.members.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

interface OverlayTargetResource extends ScopedGraphResource {
  id: string;
  label: CanvasNodeLabel;
  name: string;
  orgId: string;
  revisionSha: string;
}

function overlayTargetFromRecord(
  record: GraphReadRecord,
  expectedNodeId: string,
  expectedOrgId: string,
  scope: ReadScope,
): OverlayTargetResource | null {
  const id = valueAsString(record, 'target_id');
  const label = valueAsString(record, 'target_label');
  const name = valueAsOptionalString(record, 'target_name');
  const orgId = valueAsString(record, 'target_org_id');
  const repoId = valueAsString(record, 'target_repo_id');
  const refName = valueAsString(record, 'target_ref_name');
  const revisionSha = valueAsString(record, 'target_revision_sha');
  const path = valueAsCanonicalPath(record, 'target_path');
  if (
    id !== expectedNodeId ||
    !isCanvasLabel(label) ||
    !name ||
    orgId !== expectedOrgId ||
    !repoId ||
    !refName ||
    !revisionSha ||
    path === null
  ) {
    return null;
  }
  const target = { id, label, name, orgId, repoId, refName, revisionSha, path };
  return canReadResource(scope, target) ? target : null;
}

function sameOverlayTarget(
  left: OverlayTargetResource,
  right: OverlayTargetResource,
): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.name === right.name &&
    left.orgId === right.orgId &&
    left.repoId === right.repoId &&
    left.refName === right.refName &&
    left.revisionSha === right.revisionSha &&
    left.path === right.path
  );
}

function overlayDependency(
  record: GraphReadRecord,
  prefix: 'out_dependency_' | 'in_dependency_',
  target: OverlayTargetResource,
  scope: ReadScope,
): OverlayDependency | null {
  const id = valueAsString(record, `${prefix}id`);
  const label = valueAsString(record, `${prefix}label`);
  const name = valueAsOptionalString(record, `${prefix}name`);
  const orgId = valueAsString(record, `${prefix}org_id`);
  const repoId = valueAsString(record, `${prefix}repo_id`);
  const refName = valueAsString(record, `${prefix}ref_name`);
  const revisionSha = valueAsString(record, `${prefix}revision_sha`);
  const path = valueAsCanonicalPath(record, `${prefix}path`);
  if (
    !id ||
    !isCanvasLabel(label) ||
    !name ||
    orgId !== target.orgId ||
    repoId !== target.repoId ||
    refName !== target.refName ||
    revisionSha !== target.revisionSha ||
    path === null ||
    !canReadResource(scope, { repoId, refName, path })
  ) {
    return null;
  }
  return {
    id,
    label,
    name,
    path,
    relationship: 'IMPORTS',
    direction: prefix === 'out_dependency_' ? 'outbound' : 'inbound',
  };
}

function overlayRecentChange(
  record: GraphReadRecord,
  target: OverlayTargetResource,
): OverlayRecentChange | null {
  const commitId = valueAsString(record, 'commit_id');
  const sha = valueAsString(record, 'commit_sha');
  const timestamp = valueAsString(record, 'commit_timestamp');
  if (
    !commitId ||
    !sha ||
    !timestamp ||
    !Number.isFinite(Date.parse(timestamp)) ||
    valueAsString(record, 'commit_org_id') !== target.orgId ||
    valueAsString(record, 'commit_repository_id') !== target.repoId ||
    valueAsString(record, 'commit_ref_name') !== target.refName ||
    valueAsString(record, 'modified_org_id') !== target.orgId
  ) {
    return null;
  }
  const authorInScope =
    valueAsString(record, 'author_org_id') === target.orgId &&
    valueAsString(record, 'authored_org_id') === target.orgId;
  return {
    commitId,
    sha,
    message: valueAsOptionalString(record, 'commit_message'),
    timestamp,
    authorName: authorInScope
      ? valueAsOptionalString(record, 'author_name')
      : null,
    authorLogin: authorInScope
      ? valueAsOptionalString(record, 'author_login')
      : null,
    pullRequestTitle: valueAsOptionalString(record, 'recent_pr_title'),
    pullRequestUrl: safeWebUrl(valueAsOptionalString(record, 'recent_pr_url')),
  };
}

function overlayFeature(
  record: GraphReadRecord,
  target: OverlayTargetResource,
): OverlayFeature | null {
  const id = valueAsString(record, 'feature_id');
  const name = valueAsOptionalString(record, 'feature_name');
  return (
    id &&
    name &&
    valueAsString(record, 'feature_org_id') === target.orgId &&
    valueAsString(record, 'feature_repo_id') === target.repoId &&
    valueAsString(record, 'feature_ref_name') === target.refName &&
    valueAsString(record, 'feature_revision_sha') === target.revisionSha &&
    valueAsString(record, 'membership_org_id') === target.orgId
  )
    ? {
        id,
        name,
        description: valueAsOptionalString(record, 'feature_description'),
        team: valueAsOptionalString(record, 'feature_team'),
      }
    : null;
}

function overlayTicket(
  record: GraphReadRecord,
  target: OverlayTargetResource,
): OverlayTicket | null {
  const id = valueAsString(record, 'ticket_id');
  const externalId = valueAsOptionalString(record, 'ticket_external_id');
  const system = valueAsOptionalString(record, 'ticket_system');
  return (
    id &&
    externalId &&
    system &&
    valueAsString(record, 'ticket_org_id') === target.orgId &&
    valueAsString(record, 'ticket_repo_id') === target.repoId &&
    valueAsString(record, 'ticket_ref_name') === target.refName &&
    valueAsString(record, 'reference_org_id') === target.orgId
  )
    ? {
        id,
        externalId,
        system,
        title: valueAsOptionalString(record, 'ticket_title'),
        status: valueAsOptionalString(record, 'ticket_status'),
        url: safeWebUrl(valueAsOptionalString(record, 'ticket_url')),
      }
    : null;
}

function overlayDescription(record: GraphReadRecord): string | null {
  const value = valueAsOptionalString(record, 'target_description');
  return value !== null && value.length <= 16_384 ? value : null;
}

function distinctNodeOverlay(
  records: readonly GraphReadRecord[],
  nodeId: string,
  orgId: string,
  scope: ReadScope,
): NodeOverlayGraphSnapshot | null {
  let target: OverlayTargetResource | null = null;
  let description: string | null = null;
  const dependencies = new Map<string, OverlayDependency>();
  const recentChanges = new Map<string, OverlayRecentChange>();
  const features = new Map<string, OverlayFeature>();
  const tickets = new Map<string, OverlayTicket>();

  for (const record of records) {
    const rowTarget = overlayTargetFromRecord(record, nodeId, orgId, scope);
    if (!rowTarget) continue;
    if (target !== null && !sameOverlayTarget(target, rowTarget)) return null;
    target = rowTarget;
    description ??= overlayDescription(record);

    for (const prefix of ['out_dependency_', 'in_dependency_'] as const) {
      const dependency = overlayDependency(record, prefix, rowTarget, scope);
      if (dependency) {
        dependencies.set(`${dependency.direction}:${dependency.id}`, dependency);
      }
    }
    const change = overlayRecentChange(record, rowTarget);
    if (change) recentChanges.set(change.commitId, change);
    const feature = overlayFeature(record, rowTarget);
    if (feature) features.set(feature.id, feature);
    const ticket = overlayTicket(record, rowTarget);
    if (ticket) tickets.set(ticket.id, ticket);
  }

  if (!target) return null;
  return {
    node: {
      id: target.id,
      label: target.label,
      name: target.name,
      path: target.path,
      repositoryId: target.repoId,
      refName: target.refName,
      revisionSha: target.revisionSha,
    },
    dependencies: [...dependencies.values()]
      .sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id))
      .slice(0, 128),
    recentChanges: [...recentChanges.values()]
      .sort(
        (a, b) =>
          Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
          a.commitId.localeCompare(b.commitId),
      )
      .slice(0, 50),
    features: [...features.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .slice(0, 64),
    description,
    tickets: [...tickets.values()]
      .sort(
        (a, b) =>
          a.system.localeCompare(b.system) ||
          a.externalId.localeCompare(b.externalId),
      )
      .slice(0, 64),
  };
}

function valueAsStringArray(
  record: GraphReadRecord,
  key: string,
): string[] | null {
  const value = record.get(key);
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item) return null;
    result.push(item);
  }
  return [...new Set(result)].sort();
}

function mapOnboardingSteps(
  records: readonly GraphReadRecord[],
  expected: { orgId: string; repoId: string; refName: string },
): Pick<OnboardingGraphProjection, 'revisionSha' | 'steps'> | null {
  let revisionSha: string | null = null;
  const steps = new Map<string, OnboardingGraphStep>();
  const sequences = new Set<number>();

  for (const record of records) {
    if (
      valueAsString(record, 'root_org_id') !== expected.orgId ||
      valueAsString(record, 'root_repo_id') !== expected.repoId ||
      valueAsString(record, 'root_ref_name') !== expected.refName
    ) {
      return null;
    }
    const rowRevision = valueAsString(record, 'root_revision_sha');
    if (!rowRevision || (revisionSha !== null && revisionSha !== rowRevision)) {
      return null;
    }
    revisionSha = rowRevision;

    const id = valueAsString(record, 'step_id');
    if (id === null) continue;
    const sequence = valueAsSafeInteger(record, 'step_sequence');
    const command = valueAsString(record, 'step_command');
    const requires = valueAsStringArray(record, 'prerequisite_ids');
    if (
      valueAsString(record, 'step_org_id') !== expected.orgId ||
      valueAsString(record, 'step_repo_id') !== expected.repoId ||
      valueAsString(record, 'step_ref_name') !== expected.refName ||
      valueAsString(record, 'step_revision_sha') !== rowRevision ||
      sequence === null ||
      sequence < 0 ||
      sequence >= 24 ||
      !command ||
      command.length > 4_096 ||
      command.includes('\0') ||
      requires === null ||
      steps.has(id) ||
      sequences.has(sequence)
    ) {
      return null;
    }
    sequences.add(sequence);
    steps.set(id, { id, sequence, command, requires });
  }

  if (revisionSha === null) return null;
  const ordered = [...steps.values()].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  if (ordered.some((step, index) => step.sequence !== index)) return null;
  const byId = new Map(ordered.map((step) => [step.id, step]));
  for (const step of ordered) {
    if (
      step.requires.some((requiredId) => {
        const required = byId.get(requiredId);
        return required === undefined || required.sequence >= step.sequence;
      })
    ) {
      return null;
    }
  }
  return { revisionSha, steps: ordered };
}

function valueAsPath(record: GraphReadRecord, key: string): string | null {
  const value = record.get(key);
  return typeof value === 'string' ? value : null;
}

function mapOnboardingNode(
  record: GraphReadRecord,
  scope: ReadScope,
  expected: {
    orgId: string;
    repoId: string;
    refName: string;
    revisionSha: string;
  },
): GraphNode | null {
  const id = valueAsString(record, 'id');
  const label = valueAsString(record, 'label');
  const name = valueAsString(record, 'name');
  const path = valueAsPath(record, 'path');
  if (
    !id ||
    !isCanvasLabel(label) ||
    !name ||
    path === null ||
    valueAsString(record, 'org_id') !== expected.orgId ||
    valueAsString(record, 'repo_id') !== expected.repoId ||
    valueAsString(record, 'ref_name') !== expected.refName ||
    valueAsString(record, 'revision_sha') !== expected.revisionSha ||
    valueAsString(record, 'root_revision_sha') !== expected.revisionSha ||
    !canReadResource(scope, {
      repoId: expected.repoId,
      refName: expected.refName,
      path,
    })
  ) {
    return null;
  }

  const rawParentId = valueAsString(record, 'parent_id');
  const parentPath = valueAsPath(record, 'parent_path');
  const parentId =
    rawParentId &&
    parentPath !== null &&
    valueAsString(record, 'parent_org_id') === expected.orgId &&
    valueAsString(record, 'parent_repo_id') === expected.repoId &&
    valueAsString(record, 'parent_ref_name') === expected.refName &&
    valueAsString(record, 'parent_revision_sha') === expected.revisionSha &&
    canReadResource(scope, {
      repoId: expected.repoId,
      refName: expected.refName,
      path: parentPath,
    })
      ? rawParentId
      : null;
  return { id, label, name, path, parentId };
}

function isStructuralEdgeType(value: string | null): value is StructuralEdgeType {
  return value === 'CONTAINS' || value === 'IMPORTS';
}

function scopeParameters(scope: ReadScope): Record<string, unknown> {
  return {
    allow_rules: cypherRules(scope.allows),
    deny_rules: cypherRules(scope.denies, 'deny-root'),
  };
}

export class RbacGraphQueryService
  implements
    GraphQueryService,
    RetrievalGraphQueryService,
    StyleRuleGraphQueryService,
    NodeOverlayGraphQueryService,
    OnboardingGraphQueryService
{
  constructor(
    private readonly graph: GraphReadExecutor,
    private readonly permissions: PermissionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async getNodesInViewport(
    repoId: string,
    refName: string,
    viewport: Viewport,
    ctx: AuthContext,
  ): Promise<GraphNode[]> {
    const normalizedRepoId = repoId.trim();
    const normalizedRefName = canonicalRefName(refName);
    if (!normalizedRepoId || normalizedRefName === null) return [];
    const scope = await this.permissions.getReadScope(ctx, normalizedRepoId);
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
      repo_id: normalizedRepoId,
      ref_name: normalizedRefName,
      viewport_min_x: viewport.x,
      viewport_max_x: viewportMaxX,
      viewport_min_y: viewport.y,
      viewport_max_y: viewportMaxY,
      ...scopeParameters(scope),
    });
    return distinctViewportNodes(result.records, scope, this.now(), {
      repoId: normalizedRepoId,
      refName: normalizedRefName,
    });
  }

  async getStructuralEdges(
    repoId: string,
    refName: string,
    nodeIds: readonly string[],
    ctx: AuthContext,
  ): Promise<GraphEdge[]> {
    const normalizedRepoId = repoId.trim();
    const normalizedRefName = canonicalRefName(refName);
    if (!normalizedRepoId || normalizedRefName === null) return [];
    const ids = [...new Set(nodeIds.filter((id) => id.trim().length > 0))];
    if (ids.length === 0) return [];
    const scope = await this.permissions.getReadScope(ctx, normalizedRepoId);
    if (scope.allows.length === 0) return [];

    const result = await this.graph.run(ctx.orgId, 'traversal', GET_STRUCTURAL_EDGES_CYPHER, {
      org_id: ctx.orgId,
      repo_id: normalizedRepoId,
      ref_name: normalizedRefName,
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
        sourceResource.repoId !== normalizedRepoId ||
        targetResource.repoId !== normalizedRepoId ||
        sourceResource.refName !== normalizedRefName ||
        targetResource.refName !== normalizedRefName ||
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
    const distinctPaths = [
      ...new Set(
        paths.filter(
          (path) =>
            path.length > 0 && canonicalRelativePath(path) === path,
        ),
      ),
    ];
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

  async resolveRetrievalAnchors(
    terms: readonly string[],
    exactNodeId: string | null,
    limit: number,
    ctx: AuthContext,
  ): Promise<RetrievalGraphNode[]> {
    if (
      limit < 1 ||
      limit > 8 ||
      !Number.isSafeInteger(limit) ||
      (exactNodeId === null && terms.length === 0)
    ) {
      return [];
    }
    const scope = await this.permissions.getReadScope(ctx);
    if (scope.allows.length === 0) return [];

    const result = await this.graph.run(ctx.orgId, 'traversal', RESOLVE_RETRIEVAL_ANCHORS_CYPHER, {
      org_id: ctx.orgId,
      query_terms: [...terms],
      normalized_query: terms.join(' '),
      exact_node_id: exactNodeId,
      limit: toNeo4jInt(limit),
      ...scopeParameters(scope),
    });

    const nodes = new Map<string, RetrievalGraphNode>();
    for (const record of result.records) {
      const node = mapRetrievalNode(record, scope, ctx.orgId);
      if (node) nodes.set(node.id, node);
    }
    return [...nodes.values()].slice(0, limit);
  }

  async traverseRetrievalContext(
    anchorId: string,
    intentTerms: readonly string[],
    maxHops: number,
    maxNodes: number,
    ctx: AuthContext,
  ): Promise<RetrievalTraversal | null> {
    if (
      !anchorId.trim() ||
      !Number.isSafeInteger(maxHops) ||
      maxHops < 0 ||
      maxHops > 2 ||
      !Number.isSafeInteger(maxNodes) ||
      maxNodes < 1 ||
      maxNodes > 64
    ) {
      return null;
    }
    const scope = await this.permissions.getReadScope(ctx);
    if (scope.allows.length === 0) return null;

    const result = await this.graph.run(ctx.orgId, 'traversal', TRAVERSE_RETRIEVAL_CONTEXT_CYPHER, {
      org_id: ctx.orgId,
      anchor_id: anchorId,
      intent_terms: [...intentTerms],
      max_hops: maxHops,
      limit: toNeo4jInt(maxNodes),
      ...scopeParameters(scope),
    });

    let anchor: RetrievalGraphNode | null = null;
    const nodes = new Map<string, RetrievalGraphNode>();
    for (const record of result.records) {
      const mappedAnchor = mapRetrievalNode(record, scope, ctx.orgId, 'anchor_');
      const node = mapRetrievalNode(record, scope, ctx.orgId);
      if (
        !mappedAnchor ||
        mappedAnchor.id !== anchorId ||
        !node ||
        node.repositoryId !== mappedAnchor.repositoryId ||
        node.refName !== mappedAnchor.refName ||
        node.revisionSha !== mappedAnchor.revisionSha ||
        node.distance > maxHops
      ) {
        continue;
      }
      anchor ??= mappedAnchor;
      if (
        anchor.id !== mappedAnchor.id ||
        anchor.repositoryId !== mappedAnchor.repositoryId ||
        anchor.refName !== mappedAnchor.refName ||
        anchor.revisionSha !== mappedAnchor.revisionSha
      ) {
        continue;
      }
      nodes.set(node.id, node);
    }
    if (!anchor) return null;
    nodes.set(anchor.id, anchor);
    return { anchor, nodes: [...nodes.values()].slice(0, maxNodes) };
  }

  async getFeatureClusters(
    repoId: string,
    refName: string,
    ctx: AuthContext,
  ): Promise<FeatureCluster[]> {
    const normalizedRepoId = repoId.trim();
    const normalizedRefName = refName.trim();
    if (!normalizedRepoId || !normalizedRefName) return [];

    const scope = await this.permissions.getReadScope(ctx, normalizedRepoId);
    if (scope.allows.length === 0) return [];

    const result = await this.graph.run(
      ctx.orgId,
      'traversal',
      GET_FEATURE_CLUSTERS_CYPHER,
      {
        org_id: ctx.orgId,
        repo_id: normalizedRepoId,
        ref_name: normalizedRefName,
        ...scopeParameters(scope),
      },
    );

    return distinctFeatureClusters(result.records, scope, {
      orgId: ctx.orgId,
      repoId: normalizedRepoId,
      refName: normalizedRefName,
    });
  }

  async getNodeOverlay(
    nodeId: string,
    ctx: AuthContext,
  ): Promise<NodeOverlayGraphSnapshot | null> {
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

    const result = await this.graph.run(
      ctx.orgId,
      'traversal',
      GET_NODE_OVERLAY_CYPHER,
      {
        org_id: ctx.orgId,
        node_id: requestedNodeId,
        ...scopeParameters(scope),
      },
    );
    return distinctNodeOverlay(
      result.records,
      requestedNodeId,
      ctx.orgId,
      scope,
    );
  }

  async getOnboardingProjection(
    repoId: string,
    refName: string,
    ctx: AuthContext,
  ): Promise<OnboardingGraphProjection | null> {
    const normalizedRepoId = repoId.trim();
    const normalizedRefName = refName.trim();
    if (!normalizedRepoId || !normalizedRefName) return null;
    const scope = await this.permissions.getReadScope(ctx, normalizedRepoId);
    if (scope.allows.length === 0) return null;
    if (
      !canReadResource(scope, {
        repoId: normalizedRepoId,
        refName: normalizedRefName,
        path: '',
      })
    ) {
      return null;
    }

    const parameters = {
      org_id: ctx.orgId,
      repo_id: normalizedRepoId,
      ref_name: normalizedRefName,
      ...scopeParameters(scope),
    };
    const stepResult = await this.graph.run(
      ctx.orgId,
      'traversal',
      GET_ONBOARDING_STEPS_CYPHER,
      parameters,
    );
    const workflow = mapOnboardingSteps(stepResult.records, {
      orgId: ctx.orgId,
      repoId: normalizedRepoId,
      refName: normalizedRefName,
    });
    if (workflow === null) return null;

    const nodeResult = await this.graph.run(
      ctx.orgId,
      'traversal',
      GET_ONBOARDING_CANVAS_NODES_CYPHER,
      { ...parameters, revision_sha: workflow.revisionSha },
    );
    const expected = {
      orgId: ctx.orgId,
      repoId: normalizedRepoId,
      refName: normalizedRefName,
      revisionSha: workflow.revisionSha,
    };
    const nodes = new Map<string, GraphNode>();
    for (const record of nodeResult.records) {
      const node = mapOnboardingNode(record, scope, expected);
      if (node) nodes.set(node.id, node);
    }
    if (![...nodes.values()].some((node) => node.path === '')) return null;
    return {
      ...workflow,
      nodes: [...nodes.values()].sort(
        (left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id),
      ),
    };
  }
}

export const graphQueryService:
  GraphQueryService &
  RetrievalGraphQueryService &
  StyleRuleGraphQueryService &
  NodeOverlayGraphQueryService &
  OnboardingGraphQueryService =
  new RbacGraphQueryService(
    new LazyGraphReadExecutor(),
    new PostgresPermissionStore(),
  );

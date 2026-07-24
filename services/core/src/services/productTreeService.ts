// Product Tree business composition stays reusable across REST, GraphQL, and
// future MCP adapters. Authorization and traversal remain in Graph Query Service.

import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type {
  FeatureRecentEdit,
  GraphNode,
  GraphQueryService,
} from '../graph-query/types';

export const DEFAULT_PRODUCT_TREE_REF = 'refs/heads/main';

export interface ProductTreeFile {
  id: string;
  name: string;
  path: string;
}

export interface ProductTreeFeature {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
  memberIds: string[];
  filesIncluded: ProductTreeFile[];
  recentEdits: FeatureRecentEdit[];
}

export interface ProductTree {
  authorization: 'server-filtered';
  repoId: string;
  refName: string;
  visibleNodeCount: number;
  nodes: GraphNode[];
  features: ProductTreeFeature[];
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });
}

export function normalizeProductTreeRef(refName: string): string {
  const normalized = refName.trim();
  if (
    !normalized ||
    normalized.length > 1_024 ||
    containsControlCharacter(normalized)
  ) {
    throw new RangeError('ref must be a non-blank Git ref');
  }
  return normalized.startsWith('refs/') ? normalized : `refs/heads/${normalized}`;
}

function nodeKey(node: GraphNode): string {
  return JSON.stringify([node.label, node.name, node.path, node.parentId]);
}

export async function getProductTree(
  repoId: string,
  refName: string,
  ctx: AuthContext,
  graph: GraphQueryService = graphQueryService,
): Promise<ProductTree> {
  const normalizedRepoId = repoId.trim();
  if (!normalizedRepoId) throw new RangeError('repoId is required');
  const normalizedRefName = normalizeProductTreeRef(refName);
  const clusters = await graph.getFeatureClusters(normalizedRepoId, normalizedRefName, ctx);
  const nodes = new Map<string, GraphNode>();

  const features = clusters.flatMap<ProductTreeFeature>((cluster) => {
    const memberIds: string[] = [];
    const filesIncluded: ProductTreeFile[] = [];
    const recentEdits: FeatureRecentEdit[] = [];

    for (const member of cluster.members) {
      const node: GraphNode = {
        id: member.id,
        label: 'File',
        name: member.name,
        path: member.path,
        parentId: null,
      };
      const existing = nodes.get(node.id);
      if (existing !== undefined && nodeKey(existing) !== nodeKey(node)) {
        // A stable UID resolving to two resources indicates corrupt graph data.
        // Fail closed rather than returning an ambiguous cross-scope projection.
        throw new Error('Product Tree graph returned an inconsistent File identity.');
      }
      nodes.set(node.id, node);
      memberIds.push(node.id);
      filesIncluded.push({ id: node.id, name: node.name, path: node.path });
      if (member.recentEdit !== null) recentEdits.push(member.recentEdit);
    }

    if (memberIds.length === 0) return [];
    recentEdits.sort(
      (a, b) =>
        Date.parse(b.editedAt) - Date.parse(a.editedAt) ||
        a.filePath.localeCompare(b.filePath),
    );
    return [{
      id: cluster.id,
      name: cluster.name,
      description: cluster.description,
      team: cluster.team,
      memberIds,
      filesIncluded,
      recentEdits,
    }];
  });

  const visibleNodes = [...nodes.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id),
  );
  return {
    authorization: 'server-filtered',
    repoId: normalizedRepoId,
    refName: normalizedRefName,
    visibleNodeCount: visibleNodes.length,
    nodes: visibleNodes,
    features,
  };
}

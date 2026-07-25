import { GRAPH_EDGES, GRAPH_NODES } from '../fixtures';
import type { OverlayDependency } from '../types';

const NODES_BY_ID = new Map(GRAPH_NODES.map((node) => [node.id, node]));

/** Every node contained by `nodeId`, including itself. */
function subtreeOf(nodeId: string): Set<string> {
  const contained = new Set<string>([nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of GRAPH_NODES) {
      if (
        node.parentId !== null &&
        contained.has(node.parentId) &&
        !contained.has(node.id)
      ) {
        contained.add(node.id);
        grew = true;
      }
    }
  }
  return contained;
}

/**
 * Import dependencies for a node. For a Folder this rolls up the imports of
 * everything it contains, dropping edges that stay inside the folder — those
 * are internal structure, not a dependency of the folder.
 */
export function dependenciesFor(nodeId: string): OverlayDependency[] {
  const scope = subtreeOf(nodeId);
  const seen = new Set<string>();
  const dependencies: OverlayDependency[] = [];

  for (const edge of GRAPH_EDGES) {
    if (edge.type !== 'IMPORTS') continue;

    const sourceInScope = scope.has(edge.source);
    const targetInScope = scope.has(edge.target);
    if (sourceInScope === targetInScope) continue;

    const otherId = sourceInScope ? edge.target : edge.source;
    const other = NODES_BY_ID.get(otherId);
    if (other === undefined) continue;

    const direction = sourceInScope ? 'outbound' : 'inbound';
    const key = `${direction}:${otherId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    dependencies.push({
      nodeId: other.id,
      name: other.name,
      path: other.path,
      kind: other.kind,
      direction,
    });
  }

  return dependencies.sort((a, b) =>
    a.direction === b.direction
      ? a.path.localeCompare(b.path)
      : a.direction === 'outbound'
        ? -1
        : 1,
  );
}

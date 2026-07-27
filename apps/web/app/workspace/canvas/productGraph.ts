import type { Feature, GraphEdge, GraphNode } from '../types';

export interface ProductClusterFile {
  id: string;
  name: string;
  path: string;
  x: number;
  y: number;
}

export interface ProductClusterDirectory {
  id: string;
  label: string;
  path: string;
  x: number;
  y: number;
  files: ProductClusterFile[];
  visibleFileCount: number;
  hiddenFileCount: number;
}

export interface ProductFeatureCluster {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
  memberIds: string[];
  fileCount: number;
  workspaceCount: number;
  radius: number;
  diameter: number;
  directories: ProductClusterDirectory[];
  directoryCount: number;
  hiddenDirectoryCount: number;
}

export interface ProductFeatureConnection {
  id: string;
  sourceFeatureId: string;
  targetFeatureId: string;
  sharedFileIds: string[];
  dependencyCount: number;
  /** Counts use the stable source/target ordering above. */
  sourceToTargetDependencyCount: number;
  targetToSourceDependencyCount: number;
}

export interface ProductFeaturePlacement {
  cluster: ProductFeatureCluster;
  x: number;
  y: number;
}

export interface ProductFeatureFocus {
  adjacentFeatureIds: ReadonlySet<string>;
  activeConnectionIds: ReadonlySet<string>;
}

export const FEATURE_LABEL_WIDTH = 172;
export const MAX_VISIBLE_FEATURE_DIRECTORIES = 8;
export const MAX_VISIBLE_FILES_PER_DIRECTORY = 6;

const MIN_RADIUS = 78;
const MAX_RADIUS = 116;
const FEATURE_COLUMN_GAP = 74;
const FEATURE_ROW_GAP = 78;

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

function directoryPath(path: string): string {
  const normalized = normalizePath(path);
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '(repository root)' : normalized.slice(0, separator);
}

function directoryLabel(path: string): string {
  if (path === '(repository root)') return 'root/';
  const parts = path.split('/');
  const tail = parts.at(-1) ?? path;
  if (tail === 'src' && parts.length > 1) {
    return `${parts.at(-2)}/src/`;
  }
  return `${tail}/`;
}

function workspaceForPath(path: string): string {
  const parts = normalizePath(path).split('/');
  if (
    (parts[0] === 'apps' ||
      parts[0] === 'packages' ||
      parts[0] === 'services') &&
    parts[1] !== undefined
  ) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? '(repository root)';
}

function featureRadius(directoryCount: number, fileCount: number): number {
  const visualDirectoryCount = Math.min(
    directoryCount,
    MAX_VISIBLE_FEATURE_DIRECTORIES,
  );
  const radius = 66 + visualDirectoryCount * 7 + Math.sqrt(fileCount) * 4;
  return Math.round(Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius)));
}

function gridPosition(
  index: number,
  count: number,
  radius: number,
): { x: number; y: number } {
  if (count <= 1) return { x: 0, y: 0 };
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const inset = Math.min(46, radius * 0.42);
  const horizontalSpan = Math.max(0, radius * 2 - inset * 2);
  const verticalSpan = Math.max(0, radius * 2 - inset * 2);
  return {
    x:
      columns === 1
        ? 0
        : -radius + inset + (column * horizontalSpan) / (columns - 1),
    y:
      rows === 1
        ? 0
        : -radius + inset + (row * verticalSpan) / (rows - 1),
  };
}

/**
 * Builds the visual feature bundles from the already-authorized Product Tree
 * payload. Product files do not carry Folder nodes, so directory glyphs are
 * derived only from each authorized file path and never trigger traversal.
 *
 * The graph can contain hundreds of files in one inferred feature. The node
 * therefore renders a bounded visual sample while retaining exact total counts
 * and the complete file list in the feature drawer.
 */
export function buildProductFeatureClusters(
  graphNodes: readonly GraphNode[],
  features: readonly Feature[],
): ProductFeatureCluster[] {
  const filesById = new Map(
    graphNodes
      .filter((node) => node.kind === 'File')
      .map((node) => [node.id, node]),
  );

  return features.map((feature) => {
    const files = feature.memberIds
      .map((memberId) => filesById.get(memberId))
      .filter((file): file is GraphNode => file !== undefined);
    const filesByDirectory = new Map<string, GraphNode[]>();
    for (const file of files) {
      const path = directoryPath(file.path);
      const directoryFiles = filesByDirectory.get(path) ?? [];
      directoryFiles.push(file);
      filesByDirectory.set(path, directoryFiles);
    }

    const radius = featureRadius(filesByDirectory.size, files.length);
    const directoryEntries = [...filesByDirectory.entries()].sort(
      ([leftPath, leftFiles], [rightPath, rightFiles]) =>
        rightFiles.length - leftFiles.length ||
        leftPath.localeCompare(rightPath, undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
    );
    const visibleDirectoryEntries = directoryEntries.slice(
      0,
      MAX_VISIBLE_FEATURE_DIRECTORIES,
    );
    const directories = visibleDirectoryEntries.map<ProductClusterDirectory>(
      ([path, directoryFiles], directoryIndex) => {
        const { x, y } = gridPosition(
          directoryIndex,
          visibleDirectoryEntries.length,
          radius,
        );
        const sortedFiles = [...directoryFiles].sort(
          (left, right) =>
            left.path.localeCompare(right.path, undefined, {
              numeric: true,
              sensitivity: 'base',
            }) || left.id.localeCompare(right.id),
        );

        return {
          id: `${feature.id}:${path}`,
          path,
          label: directoryLabel(path),
          x,
          y,
          visibleFileCount: Math.min(
            sortedFiles.length,
            MAX_VISIBLE_FILES_PER_DIRECTORY,
          ),
          hiddenFileCount: Math.max(
            0,
            sortedFiles.length - MAX_VISIBLE_FILES_PER_DIRECTORY,
          ),
          files: sortedFiles.map((file, fileIndex) => {
            const visibleFileCount = Math.min(
              sortedFiles.length,
              MAX_VISIBLE_FILES_PER_DIRECTORY,
            );
            const fileAngle =
              -Math.PI / 2 +
              (fileIndex * Math.PI * 2) / Math.max(1, visibleFileCount);
            const fileOrbit = 17;
            return {
              id: file.id,
              name: file.name,
              path: file.path,
              x: x + Math.cos(fileAngle) * fileOrbit,
              y: y + Math.sin(fileAngle) * fileOrbit,
            };
          }),
        };
      },
    );

    return {
      id: feature.id,
      name: feature.name,
      description: feature.description,
      team: feature.team,
      memberIds: files.map(({ id }) => id),
      fileCount: files.length,
      workspaceCount: new Set(files.map(({ path }) => workspaceForPath(path))).size,
      radius,
      diameter: radius * 2,
      directories,
      directoryCount: directoryEntries.length,
      hiddenDirectoryCount: Math.max(
        0,
        directoryEntries.length - visibleDirectoryEntries.length,
      ),
    };
  });
}

interface MutableConnection {
  sourceFeatureId: string;
  targetFeatureId: string;
  sharedFileIds: Set<string>;
  dependencyIds: Set<string>;
  sourceToTargetDependencyIds: Set<string>;
  targetToSourceDependencyIds: Set<string>;
}

function connectionKey(leftId: string, rightId: string): string {
  return leftId.localeCompare(rightId) <= 0
    ? `${leftId}\u0000${rightId}`
    : `${rightId}\u0000${leftId}`;
}

/**
 * Relationships are factual and authorization-safe:
 * - shared files reproduce the original demo's connection rule;
 * - IMPORTS edges add cross-feature code dependencies when the authorized
 *   Technical Tree is available.
 */
export function buildProductFeatureConnections(
  features: readonly Feature[],
  graphEdges: readonly GraphEdge[],
): ProductFeatureConnection[] {
  const mutable = new Map<string, MutableConnection>();
  const featureById = new Map(features.map((feature) => [feature.id, feature]));

  const ensureConnection = (
    leftFeatureId: string,
    rightFeatureId: string,
  ): MutableConnection => {
    const key = connectionKey(leftFeatureId, rightFeatureId);
    const existing = mutable.get(key);
    if (existing !== undefined) return existing;
    const [sourceFeatureId, targetFeatureId] = key.split('\u0000') as [
      string,
      string,
    ];
    const created: MutableConnection = {
      sourceFeatureId,
      targetFeatureId,
      sharedFileIds: new Set(),
      dependencyIds: new Set(),
      sourceToTargetDependencyIds: new Set(),
      targetToSourceDependencyIds: new Set(),
    };
    mutable.set(key, created);
    return created;
  };

  for (let leftIndex = 0; leftIndex < features.length; leftIndex += 1) {
    const left = features[leftIndex];
    if (left === undefined) continue;
    const leftMembers = new Set(left.memberIds);
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < features.length;
      rightIndex += 1
    ) {
      const right = features[rightIndex];
      if (right === undefined) continue;
      const sharedFileIds = right.memberIds.filter((id) => leftMembers.has(id));
      if (sharedFileIds.length === 0) continue;
      const connection = ensureConnection(left.id, right.id);
      for (const fileId of sharedFileIds) {
        connection.sharedFileIds.add(fileId);
      }
    }
  }

  const featureIdsByMemberId = new Map<string, string[]>();
  for (const feature of features) {
    for (const memberId of feature.memberIds) {
      const owners = featureIdsByMemberId.get(memberId) ?? [];
      owners.push(feature.id);
      featureIdsByMemberId.set(memberId, owners);
    }
  }

  for (const edge of graphEdges) {
    if (edge.type !== 'IMPORTS') continue;
    const sourceOwners = featureIdsByMemberId.get(edge.source) ?? [];
    const targetOwners = featureIdsByMemberId.get(edge.target) ?? [];
    for (const sourceFeatureId of sourceOwners) {
      for (const targetFeatureId of targetOwners) {
        if (
          sourceFeatureId === targetFeatureId ||
          !featureById.has(sourceFeatureId) ||
          !featureById.has(targetFeatureId)
        ) {
          continue;
        }
        const connection = ensureConnection(
          sourceFeatureId,
          targetFeatureId,
        );
        connection.dependencyIds.add(edge.id);
        if (connection.sourceFeatureId === sourceFeatureId) {
          connection.sourceToTargetDependencyIds.add(edge.id);
        } else {
          connection.targetToSourceDependencyIds.add(edge.id);
        }
      }
    }
  }

  return [...mutable.values()]
    .map((connection) => ({
      id: `feature-link:${connection.sourceFeatureId}:${connection.targetFeatureId}`,
      sourceFeatureId: connection.sourceFeatureId,
      targetFeatureId: connection.targetFeatureId,
      sharedFileIds: [...connection.sharedFileIds].sort(),
      dependencyCount: connection.dependencyIds.size,
      sourceToTargetDependencyCount:
        connection.sourceToTargetDependencyIds.size,
      targetToSourceDependencyCount:
        connection.targetToSourceDependencyIds.size,
    }))
    .sort(
      (left, right) =>
        left.sourceFeatureId.localeCompare(right.sourceFeatureId) ||
        left.targetFeatureId.localeCompare(right.targetFeatureId),
    );
}

export function productFeatureFocus(
  selectedFeatureId: string | null,
  connections: readonly ProductFeatureConnection[],
): ProductFeatureFocus | null {
  if (selectedFeatureId === null) return null;
  const adjacentFeatureIds = new Set<string>([selectedFeatureId]);
  const activeConnectionIds = new Set<string>();
  for (const connection of connections) {
    if (
      connection.sourceFeatureId !== selectedFeatureId &&
      connection.targetFeatureId !== selectedFeatureId
    ) {
      continue;
    }
    activeConnectionIds.add(connection.id);
    adjacentFeatureIds.add(connection.sourceFeatureId);
    adjacentFeatureIds.add(connection.targetFeatureId);
  }
  return { adjacentFeatureIds, activeConnectionIds };
}

function connectedFeatureOrder(
  clusters: readonly ProductFeatureCluster[],
  connections: readonly ProductFeatureConnection[],
): ProductFeatureCluster[] {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const neighbors = new Map<string, Set<string>>();
  for (const cluster of clusters) neighbors.set(cluster.id, new Set());
  for (const connection of connections) {
    neighbors
      .get(connection.sourceFeatureId)
      ?.add(connection.targetFeatureId);
    neighbors
      .get(connection.targetFeatureId)
      ?.add(connection.sourceFeatureId);
  }
  const compareFeatureIds = (leftId: string, rightId: string): number => {
    const degreeDifference =
      (neighbors.get(rightId)?.size ?? 0) - (neighbors.get(leftId)?.size ?? 0);
    if (degreeDifference !== 0) return degreeDifference;
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    return (
      (left?.name ?? leftId).localeCompare(right?.name ?? rightId, undefined, {
        numeric: true,
        sensitivity: 'base',
      }) || leftId.localeCompare(rightId)
    );
  };

  const ordered: ProductFeatureCluster[] = [];
  const visited = new Set<string>();
  const starts = [...byId.keys()].sort(compareFeatureIds);
  for (const start of starts) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const cluster = byId.get(current);
      if (cluster !== undefined) ordered.push(cluster);
      const next = [...(neighbors.get(current) ?? [])]
        .filter((id) => !visited.has(id))
        .sort(compareFeatureIds);
      for (const id of next) {
        visited.add(id);
        queue.push(id);
      }
    }
  }
  return ordered;
}

/** Places connected clusters next to each other while retaining a stable grid. */
export function layoutProductFeatureClusters(
  clusters: readonly ProductFeatureCluster[],
  connections: readonly ProductFeatureConnection[],
  maximumColumns: number,
): ProductFeaturePlacement[] {
  if (clusters.length === 0) return [];
  const ordered = connectedFeatureOrder(clusters, connections);
  const columns =
    ordered.length <= 4
      ? Math.min(2, maximumColumns)
      : ordered.length <= 8
        ? Math.min(3, maximumColumns)
        : Math.min(4, maximumColumns);
  const safeColumns = Math.max(1, columns);
  const maximumDiameter = Math.max(...ordered.map(({ diameter }) => diameter));
  const cellWidth = maximumDiameter + FEATURE_LABEL_WIDTH + FEATURE_COLUMN_GAP;
  const cellHeight = maximumDiameter + FEATURE_ROW_GAP;

  return ordered.map((cluster, index) => ({
    cluster,
    x: (index % safeColumns) * cellWidth,
    y: Math.floor(index / safeColumns) * cellHeight,
  }));
}

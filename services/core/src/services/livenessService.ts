import type { AuthContext } from '../auth/context';
import { getNodeOverlay, type NodeOverlay } from './nodeOverlayService';

/**
 * Reachability evidence for one authorized Folder/File node.
 *
 * This is deliberately a signal, never a verdict. `no_inbound_imports` covers
 * both an abandoned file and a framework entry point, and a file imported only
 * by tests may still be a deliberately retained public API. Callers decide.
 *
 * Granularity is the file, not the symbol: only CONTAINS/IMPORTS leave the
 * Graph Query Service (see `graph-query/README.md`), so a dead export inside a
 * live file is out of scope here.
 */
export type LivenessVerdict =
  | 'imported_by_production'
  | 'imported_by_tests_only'
  | 'no_inbound_imports';

export interface NodeLiveness {
  node: { id: string; name: string; path: string };
  liveness: LivenessVerdict;
  inbound: { production: number; tests: number };
  productionImporters: string[];
  testImporters: string[];
  lastChangedAt: string | null;
}

/** Paths listed per side; counts carry the magnitude. */
const SAMPLE_LIMIT = 5;

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py|rb)$/,
  /(^|\/)test_[^/]+\.py$/,
  /Test\.(java|kt|cs)$/,
];

export function isTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function verdictFor(production: number, tests: number): LivenessVerdict {
  if (production > 0) return 'imported_by_production';
  if (tests > 0) return 'imported_by_tests_only';
  return 'no_inbound_imports';
}

export type OverlayLoader = (
  nodeId: string,
  ctx: AuthContext,
) => Promise<NodeOverlay | null>;

/**
 * Returns null for both hidden and absent nodes, matching the MCP gateway
 * contract — the two cases must stay indistinguishable to the caller.
 */
export async function getNodeLiveness(
  nodeId: string,
  ctx: AuthContext,
  loadOverlay: OverlayLoader = getNodeOverlay,
): Promise<NodeLiveness | null> {
  const overlay = await loadOverlay(nodeId, ctx);
  if (!overlay) return null;

  const inbound = overlay.dependencies.filter(
    (dependency) => dependency.direction === 'inbound',
  );
  const testImporters: string[] = [];
  const productionImporters: string[] = [];
  for (const dependency of inbound) {
    (isTestPath(dependency.path) ? testImporters : productionImporters).push(
      dependency.path,
    );
  }

  return {
    node: {
      id: overlay.node.id,
      name: overlay.node.name,
      path: overlay.node.path,
    },
    liveness: verdictFor(productionImporters.length, testImporters.length),
    inbound: {
      production: productionImporters.length,
      tests: testImporters.length,
    },
    productionImporters: productionImporters.slice(0, SAMPLE_LIMIT),
    testImporters: testImporters.slice(0, SAMPLE_LIMIT),
    lastChangedAt: overlay.recentChanges[0]?.timestamp ?? null,
  };
}

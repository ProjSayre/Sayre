export type FixtureScope = 'full' | 'limited';

export interface InteropToolCase {
  name:
    | 'find_relevant_nodes'
    | 'traverse_from'
    | 'get_node_context'
    | 'get_agent_skill_md'
    | 'get_style_rules'
    | 'get_covering_tests'
    | 'get_feature_cluster'
    | 'get_recent_changes'
    | 'check_liveness';
  arguments: Record<string, string>;
}

export const V1_TOOL_CASES: readonly InteropToolCase[] = [
  {
    name: 'find_relevant_nodes',
    arguments: { query: 'billing implementation' },
  },
  {
    name: 'traverse_from',
    arguments: {
      node_id: 'file-public',
      intent: 'billing dependencies',
    },
  },
  {
    name: 'get_node_context',
    arguments: { node_id: 'file-private' },
  },
  {
    name: 'get_agent_skill_md',
    arguments: { node_id: 'file-private' },
  },
  {
    name: 'get_style_rules',
    arguments: { node_id: 'file-private' },
  },
  {
    name: 'get_covering_tests',
    arguments: { node_id: 'file-private' },
  },
  {
    name: 'get_feature_cluster',
    arguments: { node_id: 'file-private' },
  },
  {
    name: 'get_recent_changes',
    arguments: { node_id: 'file-private' },
  },
  {
    name: 'check_liveness',
    arguments: { node_id: 'file-private' },
  },
] as const;

export const V1_TOOL_NAMES = V1_TOOL_CASES.map((entry) => entry.name);

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalized(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function assertExactArguments(
  actual: Record<string, unknown>,
  expected: Record<string, string>,
): void {
  const actualJson = canonicalJson(actual);
  const expectedJson = canonicalJson(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `The local model produced arguments outside the parity case: expected ${expectedJson}, received ${actualJson}.`,
    );
  }
}

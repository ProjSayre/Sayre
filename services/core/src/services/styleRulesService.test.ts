import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import { getStyleRules } from './styleRulesService';

const AUTH_CONTEXT: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: '11111111-1111-4111-8111-111111111111',
  roles: ['member'],
};

function fakeGraph() {
  return {
    resolveStyleRules: vi.fn(async (nodeId: string) => ({
      nodeId,
      codingStyle: { value: 'Typed boundaries.', sourceNodeId: 'folder-1' },
      commentStyle: { value: null, sourceNodeId: null },
    })),
  };
}

describe('getStyleRules', () => {
  it('delegates the node id and complete server-derived context unchanged', async () => {
    const graph = fakeGraph();

    await expect(getStyleRules('file-1', AUTH_CONTEXT, graph)).resolves.toEqual({
      nodeId: 'file-1',
      codingStyle: { value: 'Typed boundaries.', sourceNodeId: 'folder-1' },
      commentStyle: { value: null, sourceNodeId: null },
    });
    expect(graph.resolveStyleRules).toHaveBeenCalledWith('file-1', AUTH_CONTEXT);
  });

  it('fails closed on blank, padded, or oversized ids before graph access', async () => {
    const graph = fakeGraph();

    await expect(getStyleRules('', AUTH_CONTEXT, graph)).resolves.toBeNull();
    await expect(getStyleRules(' file-1 ', AUTH_CONTEXT, graph)).resolves.toBeNull();
    await expect(getStyleRules('x'.repeat(513), AUTH_CONTEXT, graph)).resolves.toBeNull();
    expect(graph.resolveStyleRules).not.toHaveBeenCalled();
  });
});

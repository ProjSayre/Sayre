import { describe, expect, it } from 'vitest';
import {
  GRAPHLOGY_PRESENTATION_ALLOWLIST,
  createScaleFixture,
  rendererForVisibleNodeCount,
  toPresentationGraph,
} from './scaleGraph';

describe('at-scale renderer selection', () => {
  it('switches to Sigma only above the 500 visible-node threshold', () => {
    expect(rendererForVisibleNodeCount(0)).toBe('react-flow');
    expect(rendererForVisibleNodeCount(500)).toBe('react-flow');
    expect(rendererForVisibleNodeCount(501)).toBe('sigma');
    expect(() => rendererForVisibleNodeCount(-1)).toThrow(RangeError);
  });

  it('builds a deterministic 2,000-node Folder/File fixture', () => {
    const fixture = createScaleFixture();

    expect(fixture.authorization).toBe('server-filtered');
    expect(fixture.visibleNodeCount).toBe(2_000);
    expect(fixture.nodes).toHaveLength(2_000);
    expect(fixture.edges).toHaveLength(1_999);
    expect(new Set(fixture.nodes.map((node) => node.id)).size).toBe(2_000);
    expect(new Set(fixture.nodes.map((node) => node.kind))).toEqual(
      new Set(['Folder', 'File']),
    );
  });

  it('constructs graphology only from the already-authorized payload', () => {
    const fixture = createScaleFixture();
    const graph = toPresentationGraph(fixture);

    expect(graph.order).toBe(2_000);
    expect(graph.size).toBe(1_999);
    expect(GRAPHLOGY_PRESENTATION_ALLOWLIST).not.toContain('RBAC filtering');
    expect(GRAPHLOGY_PRESENTATION_ALLOWLIST).not.toContain('graph traversal');
  });
});

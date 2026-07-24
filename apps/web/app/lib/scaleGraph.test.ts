import { describe, expect, it } from 'vitest';
import {
  GRAPHLOGY_PRESENTATION_ALLOWLIST,
  coverageColor,
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
    fixture.edges.push({
      id: 'imports-file-0-file-1',
      source: 'file-0',
      target: 'file-1',
      relationship: 'IMPORTS',
    });
    const graph = toPresentationGraph(fixture);

    expect(graph.order).toBe(2_000);
    expect(graph.size).toBe(2_000);
    expect(graph.getEdgeAttribute('imports-file-0-file-1', 'relationship')).toBe('IMPORTS');
    expect(GRAPHLOGY_PRESENTATION_ALLOWLIST).not.toContain('RBAC filtering');
    expect(GRAPHLOGY_PRESENTATION_ALLOWLIST).not.toContain('graph traversal');
  });

  it('uses the same coverage palette for badge-capable renderers', () => {
    expect(coverageColor('pass')).toBe('#78dba9');
    expect(coverageColor('fail')).toBe('#ff6b78');
    expect(coverageColor('stale')).toBe('#f7c66c');
    expect(coverageColor('unknown')).toBe('#8795a5');
  });
});

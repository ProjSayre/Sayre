import { describe, expect, it } from 'vitest';
import { mockEdges, mockNodes } from './mockGraph';

describe('mock graph fixture', () => {
  it('contains exactly 20 unique Folder/File nodes', () => {
    expect(mockNodes).toHaveLength(20);
    expect(new Set(mockNodes.map((node) => node.id)).size).toBe(20);
    expect(new Set(mockNodes.map((node) => node.data.kind))).toEqual(
      new Set(['Folder', 'File']),
    );
  });

  it('uses only valid node endpoints for every edge', () => {
    const nodeIds = new Set(mockNodes.map((node) => node.id));

    expect(mockEdges).toHaveLength(19);
    for (const edge of mockEdges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });
});

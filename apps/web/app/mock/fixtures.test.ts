import { describe, expect, it } from 'vitest';
import { derivePrerequisiteGraph } from '../lib/prerequisiteGraph';
import { GRAPH_EDGES, GRAPH_NODES } from './fixtures';

const graph = derivePrerequisiteGraph(
  GRAPH_NODES.map((node) => ({
    id: node.id,
    label: node.kind,
    name: node.name,
    path: node.path,
    parentId: node.parentId,
  })),
  GRAPH_EDGES,
);

/**
 * The fixture repository is what the workspace renders without a backend, so
 * these assertions keep it exercising the Onboarding view rather than
 * degenerating into a flat list that would hide the layering and cycle
 * handling entirely.
 */
describe('fixture repository as onboarding input', () => {
  it('produces a reading order deep enough to be worth ordering', () => {
    expect(graph.layerCount).toBeGreaterThanOrEqual(4);
  });

  it('starts from a single shared leaf utility', () => {
    const first = graph.nodes.filter((node) => node.layer === 0);
    expect(first.map(({ name }) => name)).toEqual(['logger.ts']);
  });

  it('contains exactly one mutually entangled group', () => {
    expect(graph.cycleGroups).toHaveLength(1);
    const [cycle] = graph.cycleGroups;
    expect(cycle.memberIds).toHaveLength(2);
    const names = cycle.memberIds
      .map((id) => graph.nodes.find((node) => node.id === id)?.name)
      .sort();
    expect(names).toEqual(['rbac.ts', 'session.ts']);
  });

  it('places both cycle members on the same layer', () => {
    const [cycle] = graph.cycleGroups;
    const layers = new Set(
      cycle.memberIds.map(
        (id) => graph.nodes.find((node) => node.id === id)?.layer,
      ),
    );
    expect(layers.size).toBe(1);
  });

  it('ends on the checkout page, which depends on the most', () => {
    const deepest = [...graph.nodes].sort((a, b) => b.layer - a.layer)[0];
    expect(deepest.name).toBe('CheckoutPage.tsx');
  });

  it('every file is reachable in the ordering', () => {
    const fileCount = GRAPH_NODES.filter((node) => node.kind === 'File').length;
    expect(graph.nodes).toHaveLength(fileCount);
  });
});

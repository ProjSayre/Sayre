import { describe, expect, it } from 'vitest';
import type { OnboardingTreeEdge, OnboardingTreeNode } from './onboardingTree';
import {
  derivePrerequisiteGraph,
  resolveProgress,
  stronglyConnectedComponents,
} from './prerequisiteGraph';

function file(id: string, path = `src/${id}.ts`): OnboardingTreeNode {
  return { id, label: 'File', name: `${id}.ts`, path, parentId: 'root' };
}

const root: OnboardingTreeNode = {
  id: 'root',
  label: 'Folder',
  name: 'src/',
  path: 'src',
  parentId: null,
};

/** `imports(a, b)` reads "a imports b", so b must be understood first. */
function imports(source: string, target: string): OnboardingTreeEdge {
  return { id: `IMPORTS:${source}:${target}`, type: 'IMPORTS', source, target };
}

function layerById(nodes: ReturnType<typeof derivePrerequisiteGraph>['nodes']) {
  return Object.fromEntries(nodes.map((node) => [node.id, node.layer]));
}

describe('stronglyConnectedComponents', () => {
  it('finds a single cycle', () => {
    const components = stronglyConnectedComponents(
      ['a', 'b', 'c'],
      new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
      ]),
    );
    expect(components).toHaveLength(1);
    expect([...components[0]].sort()).toEqual(['a', 'b', 'c']);
  });

  it('separates independent components', () => {
    const components = stronglyConnectedComponents(
      ['a', 'b', 'c', 'd'],
      new Map([
        ['a', ['b']],
        ['b', ['a']],
        ['c', ['d']],
      ]),
    );
    expect(components).toHaveLength(3);
  });

  it('does not overflow on a long chain', () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `n${i}`);
    const successors = new Map(
      ids.slice(0, -1).map((id, i) => [id, [`n${i + 1}`]] as const),
    );
    expect(stronglyConnectedComponents(ids, successors)).toHaveLength(20_000);
  });
});

describe('derivePrerequisiteGraph', () => {
  it('reverses IMPORTS so the dependency is learned first', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('page'), file('money')],
      [imports('page', 'money')],
    );

    // page imports money, so money is the prerequisite.
    expect(graph.edges).toEqual([
      {
        id: 'PREREQUISITE:money:page',
        source: 'money',
        target: 'page',
        withinGroup: false,
      },
    ]);
    expect(layerById(graph.nodes)).toEqual({ money: 0, page: 1 });
  });

  it('layers a chain by depth', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b'), file('c')],
      [imports('a', 'b'), imports('b', 'c')],
    );
    expect(layerById(graph.nodes)).toEqual({ c: 0, b: 1, a: 2 });
    expect(graph.layerCount).toBe(3);
  });

  it('uses longest-path layering so a diamond converges after both branches', () => {
    // d is imported by b and c; a imports both. a must come strictly after both.
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b'), file('c'), file('d')],
      [imports('a', 'b'), imports('a', 'c'), imports('b', 'd'), imports('c', 'd')],
    );
    expect(layerById(graph.nodes)).toEqual({ d: 0, b: 1, c: 1, a: 2 });
  });

  it('condenses a cycle into one group on a single layer', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b'), file('leaf')],
      [imports('a', 'b'), imports('b', 'a'), imports('a', 'leaf')],
    );

    const a = graph.nodes.find((node) => node.id === 'a');
    const b = graph.nodes.find((node) => node.id === 'b');
    expect(a?.groupId).toBe(b?.groupId);
    expect(a?.groupSize).toBe(2);
    expect(a?.layer).toBe(b?.layer);
    expect(graph.cycleGroups).toEqual([{ id: 'a', memberIds: ['a', 'b'] }]);
  });

  it('marks edges inside a cycle so they can be drawn differently', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b')],
      [imports('a', 'b'), imports('b', 'a')],
    );
    expect(graph.edges.every((edge) => edge.withinGroup)).toBe(true);
  });

  it('keeps singleton groups out of the cycle list', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b')],
      [imports('a', 'b')],
    );
    expect(graph.cycleGroups).toEqual([]);
    expect(graph.nodes.every((node) => node.groupSize === 1)).toBe(true);
  });

  it('places files with no import relationships on the first layer', () => {
    const graph = derivePrerequisiteGraph([root, file('orphan')], []);
    expect(layerById(graph.nodes)).toEqual({ orphan: 0 });
    expect(graph.layerCount).toBe(1);
  });

  it('excludes folders from the reading order', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('a')],
      [{ id: 'CONTAINS:root:a', type: 'CONTAINS', source: 'root', target: 'a' }],
    );
    expect(graph.nodes.map(({ id }) => id)).toEqual(['a']);
    expect(graph.edges).toEqual([]);
  });

  it('ignores CONTAINS, self-imports, and endpoints outside the file set', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('a')],
      [
        { id: 'CONTAINS:root:a', type: 'CONTAINS', source: 'root', target: 'a' },
        imports('a', 'a'),
        imports('a', 'missing'),
        imports('a', 'root'),
      ],
    );
    expect(graph.edges).toEqual([]);
    expect(layerById(graph.nodes)).toEqual({ a: 0 });
  });

  it('deduplicates repeated import pairs', () => {
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b')],
      [
        imports('a', 'b'),
        { id: 'IMPORTS:a:b:again', type: 'IMPORTS', source: 'a', target: 'b' },
      ],
    );
    expect(graph.edges).toHaveLength(1);
  });

  it('is deterministic regardless of input ordering', () => {
    const nodes = [root, file('a'), file('b'), file('c')];
    const forward = derivePrerequisiteGraph(nodes, [
      imports('a', 'b'),
      imports('b', 'c'),
    ]);
    const reversed = derivePrerequisiteGraph([...nodes].reverse(), [
      imports('b', 'c'),
      imports('a', 'b'),
    ]);
    expect(layerById(forward.nodes)).toEqual(layerById(reversed.nodes));
    expect(forward.cycleGroups).toEqual(reversed.cycleGroups);
  });

  it('reports progress as done, current, and locked', () => {
    // a imports b imports c, so the reading order is c -> b -> a.
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b'), file('c')],
      [imports('a', 'b'), imports('b', 'c')],
    );

    const fresh = resolveProgress(graph, new Set());
    expect(fresh.get('c')).toBe('current');
    expect(fresh.get('b')).toBe('locked');
    expect(fresh.get('a')).toBe('locked');

    const started = resolveProgress(graph, new Set(['c']));
    expect(started.get('c')).toBe('done');
    expect(started.get('b')).toBe('current');
    expect(started.get('a')).toBe('locked');

    const finished = resolveProgress(graph, new Set(['a', 'b', 'c']));
    expect([...finished.values()].every((state) => state === 'done')).toBe(true);
  });

  it('unlocks a cycle as one unit rather than deadlocking on itself', () => {
    // a and b import each other, and both need leaf first.
    const graph = derivePrerequisiteGraph(
      [root, file('a'), file('b'), file('leaf')],
      [imports('a', 'b'), imports('b', 'a'), imports('a', 'leaf')],
    );

    const blocked = resolveProgress(graph, new Set());
    expect(blocked.get('leaf')).toBe('current');
    expect(blocked.get('a')).toBe('locked');
    expect(blocked.get('b')).toBe('locked');

    // Once the external gate clears, both members open together — neither can
    // be a prerequisite of the other.
    const opened = resolveProgress(graph, new Set(['leaf']));
    expect(opened.get('a')).toBe('current');
    expect(opened.get('b')).toBe('current');
  });

  it('treats files with no prerequisites as immediately readable', () => {
    const graph = derivePrerequisiteGraph([root, file('solo')], []);
    expect(resolveProgress(graph, new Set()).get('solo')).toBe('current');
  });

  it('returns an empty graph when nothing is authorized', () => {
    const graph = derivePrerequisiteGraph([], []);
    expect(graph).toEqual({
      nodes: [],
      edges: [],
      layerCount: 0,
      cycleGroups: [],
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from './types';
import {
  defaultTechnicalExpansionPreferences,
  parseTechnicalExpansionPreferences,
  projectTechnicalExpansion,
  pruneTechnicalExpansionPreferences,
  serializeTechnicalExpansionPreferences,
  viewportTechnicalNodeBudget,
  type TechnicalExpansionIntent,
} from './technicalExpansion';

function intent(
  overrides: Partial<TechnicalExpansionIntent> = {},
): TechnicalExpansionIntent {
  return {
    ...defaultTechnicalExpansionPreferences(),
    focusNodeId: null,
    transientReveal: null,
    ...overrides,
  };
}

function largeGraph(): GraphNode[] {
  const nodes: GraphNode[] = [
    {
      id: 'root',
      kind: 'Folder',
      name: 'repository',
      path: '',
      parentId: null,
    },
  ];
  for (let folderIndex = 0; folderIndex < 19; folderIndex += 1) {
    const folderId = `folder-${folderIndex}`;
    nodes.push({
      id: folderId,
      kind: 'Folder',
      name: folderId,
      path: folderId,
      parentId: 'root',
    });
    const fileCount = folderIndex === 18 ? 40 : 39;
    for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
      nodes.push({
        id: `${folderId}-file-${fileIndex}`,
        kind: 'File',
        name: `file-${fileIndex}.ts`,
        path: `${folderId}/file-${fileIndex}.ts`,
        parentId: folderId,
      });
    }
  }
  return nodes;
}

describe('technical expansion projection', () => {
  it('derives a clamped adaptive viewport budget', () => {
    expect(viewportTechnicalNodeBudget(100, 100)).toBe(24);
    expect(viewportTechnicalNodeBudget(1_100, 640)).toBe(96);
    expect(viewportTechnicalNodeBudget(100_000, 100_000)).toBe(96);
    expect(viewportTechnicalNodeBudget(Number.NaN, 640)).toBe(24);
  });

  it('keeps a 762-node initial repository within budget', () => {
    const nodes = largeGraph();
    const projection = projectTechnicalExpansion(nodes, [], intent(), 24);

    expect(nodes).toHaveLength(762);
    expect(projection.nodes.length).toBeLessThanOrEqual(24);
    expect(projection.visibleNodeIds.has('root')).toBe(true);
    expect(projection.nodes.filter((node) => node.parentId === 'root')).toHaveLength(
      19,
    );
    expect(projection.foldedBranchCount).toBeGreaterThan(0);
  });

  it('keeps loose root files folded behind folder landmarks by default', () => {
    const nodes: GraphNode[] = [
      {
        id: 'root',
        kind: 'Folder',
        name: 'repository',
        path: '',
        parentId: null,
      },
      {
        id: 'apps',
        kind: 'Folder',
        name: 'apps',
        path: 'apps',
        parentId: 'root',
      },
      {
        id: 'readme',
        kind: 'File',
        name: 'README.md',
        path: 'README.md',
        parentId: 'root',
      },
      {
        id: 'package',
        kind: 'File',
        name: 'package.json',
        path: 'package.json',
        parentId: 'root',
      },
    ];

    const projection = projectTechnicalExpansion(nodes, [], intent(), 24);

    expect(projection.nodes.map((node) => node.id)).toEqual(['root', 'apps']);
    expect(projection.foldedDescendantCount.get('root')).toBe(2);
  });

  it('reveals a searched root file and its root corridor', () => {
    const nodes: GraphNode[] = [
      {
        id: 'root',
        kind: 'Folder',
        name: 'repository',
        path: '',
        parentId: null,
      },
      {
        id: 'apps',
        kind: 'Folder',
        name: 'apps',
        path: 'apps',
        parentId: 'root',
      },
      {
        id: 'readme',
        kind: 'File',
        name: 'README.md',
        path: 'README.md',
        parentId: 'root',
      },
    ];

    const projection = projectTechnicalExpansion(
      nodes,
      [],
      intent({
        transientReveal: {
          source: 'search',
          nodeIds: new Set(['readme']),
        },
      }),
      24,
    );

    expect(projection.visibleNodeIds.has('readme')).toBe(true);
    expect(projection.reasonByNodeId.get('readme')).toBe('transient');
  });

  it('forces the focused file and every authorized ancestor into view', () => {
    const nodes = largeGraph();
    const focusedId = 'folder-18-file-39';
    const projection = projectTechnicalExpansion(
      nodes,
      [],
      intent({ focusNodeId: focusedId }),
      24,
    );

    expect(projection.visibleNodeIds.has('root')).toBe(true);
    expect(projection.visibleNodeIds.has('folder-18')).toBe(true);
    expect(projection.visibleNodeIds.has(focusedId)).toBe(true);
    expect(projection.reasonByNodeId.get(focusedId)).toBe('focus-path');
    expect(projection.nodes.length).toBeLessThanOrEqual(24);
  });

  it('protects manually opened and pinned paths across unrelated selections', () => {
    const nodes = largeGraph();
    const projection = projectTechnicalExpansion(
      nodes,
      [],
      intent({
        focusNodeId: 'folder-18-file-39',
        manuallyExpanded: new Set(['folder-2']),
        pinnedBranches: new Set(['folder-3']),
        manualOrder: ['folder-3', 'folder-2'],
      }),
      24,
    );

    expect(projection.visibleNodeIds.has('folder-2')).toBe(true);
    expect(projection.visibleNodeIds.has('folder-3')).toBe(true);
    expect(
      projection.nodes.some((node) => node.parentId === 'folder-2'),
    ).toBe(true);
    expect(
      projection.nodes.some((node) => node.parentId === 'folder-3'),
    ).toBe(true);
    expect(projection.reasonByNodeId.get('folder-3')).toBe('pinned');
  });

  it('uses contextual disclosure for a folder larger than the budget', () => {
    const nodes: GraphNode[] = [
      {
        id: 'root',
        kind: 'Folder',
        name: 'root',
        path: '',
        parentId: null,
      },
      {
        id: 'large',
        kind: 'Folder',
        name: 'large',
        path: 'large',
        parentId: 'root',
      },
      ...Array.from({ length: 30 }, (_, index): GraphNode => ({
        id: `file-${index}`,
        kind: 'File',
        name: `file-${index}.ts`,
        path: `large/file-${index}.ts`,
        parentId: 'large',
      })),
    ];
    const projection = projectTechnicalExpansion(
      nodes,
      [],
      intent({
        manuallyExpanded: new Set(['large']),
        manualOrder: ['large'],
      }),
      24,
    );

    expect(projection.nodes).toHaveLength(24);
    expect(projection.folderStateById.get('large')).toBe('contextual');
    expect(projection.visibleChildCount.get('large')).toBe(22);
    expect(projection.totalChildCount.get('large')).toBe(30);
    expect(projection.foldedDescendantCount.get('large')).toBe(8);
  });

  it('honors explicit folder expansion while focus mode is active', () => {
    const nodes = largeGraph();
    const projection = projectTechnicalExpansion(
      nodes,
      [],
      intent({
        mode: 'focus',
        manuallyExpanded: new Set(['folder-2']),
        manualOrder: ['folder-2'],
      }),
      24,
    );

    expect(projection.expandedFolderIds.has('folder-2')).toBe(true);
    expect(
      projection.nodes.some((node) => node.parentId === 'folder-2'),
    ).toBe(true);
  });

  it('temporarily reveals search matches without changing the base projection', () => {
    const nodes = largeGraph();
    const preferences = {
      ...defaultTechnicalExpansionPreferences(),
      manuallyExpanded: new Set(['folder-2']),
      manualOrder: ['folder-2'],
    };
    const before = projectTechnicalExpansion(
      nodes,
      [],
      intent(preferences),
      24,
    );
    const during = projectTechnicalExpansion(
      nodes,
      [],
      intent({
        ...preferences,
        transientReveal: {
          source: 'search',
          nodeIds: new Set(['folder-18-file-39']),
        },
      }),
      24,
    );
    const after = projectTechnicalExpansion(
      nodes,
      [],
      intent(preferences),
      24,
    );

    expect(during.visibleNodeIds.has('folder-18-file-39')).toBe(true);
    expect(during.visibleTransientMatchCount).toBe(1);
    expect(after.key).toBe(before.key);
    expect([...after.visibleNodeIds]).toEqual([...before.visibleNodeIds]);
  });

  it('filters edges to visible endpoints and counts folded authorized imports', () => {
    const nodes: GraphNode[] = [
      {
        id: 'root',
        kind: 'Folder',
        name: 'root',
        path: '',
        parentId: null,
      },
      {
        id: 'src',
        kind: 'Folder',
        name: 'src',
        path: 'src',
        parentId: 'root',
      },
      {
        id: 'a',
        kind: 'File',
        name: 'a.ts',
        path: 'src/a.ts',
        parentId: 'src',
      },
      {
        id: 'b',
        kind: 'File',
        name: 'b.ts',
        path: 'src/b.ts',
        parentId: 'src',
      },
    ];
    const edges: GraphEdge[] = [
      {
        id: 'contains-src',
        type: 'CONTAINS',
        source: 'root',
        target: 'src',
      },
      {
        id: 'contains-a',
        type: 'CONTAINS',
        source: 'src',
        target: 'a',
      },
      {
        id: 'import',
        type: 'IMPORTS',
        source: 'a',
        target: 'b',
      },
    ];
    const projection = projectTechnicalExpansion(
      nodes,
      edges,
      intent({ manuallyCollapsed: new Set(['root']) }),
      24,
    );

    expect(projection.nodes.map((node) => node.id)).toEqual(['root']);
    expect(projection.edges).toEqual([]);
    expect(projection.foldedDescendantCount.get('root')).toBe(3);
    expect(projection.hiddenImportCount.get('root')).toBe(1);
  });

  it('shows the complete authorized graph only in explicit full mode', () => {
    const nodes = largeGraph();
    const projection = projectTechnicalExpansion(
      nodes,
      [],
      intent({ mode: 'full' }),
      24,
    );

    expect(projection.nodes).toHaveLength(nodes.length);
    expect(projection.overBudgetBy).toBe(nodes.length - 24);
    expect(projection.foldedBranchCount).toBe(0);
  });

  it('keeps a 2,000+ node repository bounded and focusable', () => {
    const nodes: GraphNode[] = [
      {
        id: 'root',
        kind: 'Folder',
        name: 'repository',
        path: '',
        parentId: null,
      },
    ];
    for (let folderIndex = 0; folderIndex < 40; folderIndex += 1) {
      const folderId = `package-${folderIndex}`;
      nodes.push({
        id: folderId,
        kind: 'Folder',
        name: folderId,
        path: folderId,
        parentId: 'root',
      });
      for (let fileIndex = 0; fileIndex < 50; fileIndex += 1) {
        nodes.push({
          id: `${folderId}-file-${fileIndex}`,
          kind: 'File',
          name: `file-${fileIndex}.ts`,
          path: `${folderId}/file-${fileIndex}.ts`,
          parentId: folderId,
        });
      }
    }
    const focusedId = 'package-39-file-49';
    const projection = projectTechnicalExpansion(
      nodes,
      [],
      intent({ focusNodeId: focusedId }),
      96,
    );

    expect(nodes.length).toBeGreaterThan(2_000);
    expect(projection.nodes.length).toBeLessThanOrEqual(96);
    expect(projection.visibleNodeIds.has(focusedId)).toBe(true);
    expect(projection.visibleNodeIds.has('package-39')).toBe(true);
    expect(projection.visibleNodeIds.has('root')).toBe(true);
  });
});

describe('technical expansion session state', () => {
  it('round-trips deterministic preferences and tolerates malformed state', () => {
    const preferences = {
      mode: 'focus' as const,
      manuallyExpanded: new Set(['b', 'a']),
      manuallyCollapsed: new Set(['c']),
      pinnedBranches: new Set(['b']),
      manualOrder: ['b', 'a'],
    };

    expect(
      parseTechnicalExpansionPreferences(
        serializeTechnicalExpansionPreferences(preferences),
      ),
    ).toEqual(preferences);
    expect(parseTechnicalExpansionPreferences('{oops')).toEqual(
      defaultTechnicalExpansionPreferences(),
    );
  });

  it('prunes removed IDs and non-folder preferences after realtime updates', () => {
    const preferences = {
      mode: 'balanced' as const,
      manuallyExpanded: new Set(['kept', 'removed', 'file']),
      manuallyCollapsed: new Set(['kept', 'removed']),
      pinnedBranches: new Set(['kept', 'removed']),
      manualOrder: ['removed', 'kept', 'file'],
    };
    const nodes: GraphNode[] = [
      {
        id: 'kept',
        kind: 'Folder',
        name: 'kept',
        path: 'kept',
        parentId: null,
      },
      {
        id: 'file',
        kind: 'File',
        name: 'file.ts',
        path: 'kept/file.ts',
        parentId: 'kept',
      },
    ];

    expect(pruneTechnicalExpansionPreferences(preferences, nodes)).toEqual({
      mode: 'balanced',
      manuallyExpanded: new Set(['kept']),
      manuallyCollapsed: new Set(),
      pinnedBranches: new Set(['kept']),
      manualOrder: ['kept'],
    });
  });
});

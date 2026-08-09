'use client';

import { useMemo, useState } from 'react';
import { useWorkspaceNavigation, useWorkspaceQueries, useWorkspaceSelection, useWorkspaceSession } from '../state';
import { nodeModules, type NodeModuleId } from '../moduleRegistry';
import type { GraphNode, NodeOverlay } from '../types';
import { copyText, Module } from '../components/ui';
import { nodeModuleRenderers } from './nodeModuleRenderers';

function githubSourceUrl(
  provider: string,
  repositoryName: string,
  refName: string | null,
  node: GraphNode,
): string | null {
  if (!provider.toLowerCase().includes('github')) return null;
  const [owner, repository, ...extra] = repositoryName.split('/');
  if (!owner || !repository || extra.length > 0) return null;
  const ref = (refName ?? 'main').replace(/^refs\/heads\//u, '');
  const path = node.path
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  return `${base}/${node.kind === 'Folder' ? 'tree' : 'blob'}/${encodeURIComponent(ref)}${
    path.length > 0 ? `/${path}` : ''
  }`;
}

function moduleHasData(
  moduleId: NodeModuleId,
  overlay: NodeOverlay,
): boolean {
  switch (moduleId) {
    case 'dependencies':
      return overlay.dependencies.length > 0;
    case 'recent-changes':
      return overlay.recentChanges.length > 0;
    case 'specific-features':
      return overlay.specificFeatures.length > 0;
    case 'agent-skill-md':
      return overlay.agentSkillMd !== null;
    case 'description':
      return overlay.description !== null;
    case 'specific-tickets':
      return overlay.specificTickets.length > 0;
    case 'standards':
      return false;
  }
}

const MODULE_PRIORITY: readonly NodeModuleId[] = [
  'description',
  'specific-features',
  'dependencies',
  'recent-changes',
  'specific-tickets',
  'agent-skill-md',
];

export function NodeDrawer() {
  const { graph, graphStatus, nodeOverlay, overlayStatus, reloadOverlay, semanticState } = useWorkspaceQueries();
  const { repository } = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  const [copyPathState, setCopyPathState] = useState<
    'idle' | 'copied' | 'failed'
  >('idle');
  const node =
    selection.selectedNodeId === null
      ? null
      : graph.nodes.find((candidate) => candidate.id === selection.selectedNodeId);

  const folderSummary = useMemo(() => {
    if (node?.kind !== 'Folder') return null;
    const childrenByParent = new Map<string, GraphNode[]>();
    for (const candidate of graph.nodes) {
      if (candidate.parentId === null) continue;
      const children = childrenByParent.get(candidate.parentId) ?? [];
      children.push(candidate);
      childrenByParent.set(candidate.parentId, children);
    }
    const descendantIds = new Set<string>();
    const stack = [...(childrenByParent.get(node.id) ?? [])];
    let folderCount = 0;
    let fileCount = 0;
    while (stack.length > 0) {
      const descendant = stack.pop();
      if (descendant === undefined || descendantIds.has(descendant.id)) continue;
      descendantIds.add(descendant.id);
      if (descendant.kind === 'Folder') {
        folderCount += 1;
        stack.push(...(childrenByParent.get(descendant.id) ?? []));
      } else {
        fileCount += 1;
      }
    }
    const importCount = graph.edges.filter(
      (edge) =>
        edge.type === 'IMPORTS' &&
        (descendantIds.has(edge.source) || descendantIds.has(edge.target)),
    ).length;
    return {
      directChildren: childrenByParent.get(node.id)?.length ?? 0,
      folderCount,
      fileCount,
      importCount,
    };
  }, [graph.edges, graph.nodes, node]);

  if (node === undefined || node === null) {
    if (graphStatus !== 'loading') return null;
    return (
      <aside className="mock-drawer" aria-label="Opening node details">
        <div className="mock-drawer-header">
          <div className="mock-drawer-heading">
            <span className="mock-drawer-kind">Technical Tree</span>
            <h2>Opening file context…</h2>
            <p className="mock-drawer-path">
              Loading the complete authorized repository view.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const overlay = nodeOverlay?.nodeId === node.id ? nodeOverlay : null;
  const semanticsUsable = semanticState.status !== 'failed';
  const sourceUrl =
    repository === null
      ? null
      : githubSourceUrl(
          repository.provider,
          repository.name,
          repository.currentRef ?? navigation.refName,
          node,
        );
  const orderedModules = MODULE_PRIORITY.map((moduleId) =>
    nodeModules.find((definition) => definition.id === moduleId),
  ).filter((definition): definition is (typeof nodeModules)[number] =>
    Boolean(definition),
  );
  const populatedModuleCount =
    overlay === null
      ? 0
      : orderedModules.filter((definition) =>
          moduleHasData(definition.id, overlay),
        ).length;

  return (
    <aside className="mock-drawer" aria-label={`Details for ${node.path}`}>
      <div className="mock-drawer-header">
        <div className="mock-drawer-heading">
          <span className="mock-drawer-kind">{node.kind}</span>
          <h2>{node.name}</h2>
          <p className="mock-drawer-path">{node.path || '(repository root)'}</p>
        </div>
        <div className="mock-drawer-header-actions">
          {selection.returnFeatureId !== null && (
            <button
              type="button"
              className="mock-btn mock-btn-ghost mock-btn-sm"
              data-workspace-action="back-to-feature"
              onClick={selection.returnToFeature}
            >
              ← Back to feature
            </button>
          )}
          <button
            type="button"
            className="mock-btn mock-btn-ghost mock-btn-sm"
            onClick={() => {
              void copyText(node.path).then((copied) => {
                if (!copied) {
                  setCopyPathState('failed');
                  return;
                }
                setCopyPathState('copied');
                window.setTimeout(() => setCopyPathState('idle'), 1_500);
              });
            }}
          >
            {copyPathState === 'copied'
              ? 'Copied'
              : copyPathState === 'failed'
                ? 'Select path'
                : 'Copy path'}
          </button>
          {sourceUrl !== null && (
            <a
              className="mock-btn mock-btn-ghost mock-btn-sm"
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open source ↗
            </a>
          )}
          <button
            type="button"
            className="mock-btn mock-btn-ghost"
            aria-label="Close details"
            onClick={selection.closeInspector}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="mock-drawer-scroll">
        {folderSummary !== null && (
          <Module title="Folder overview">
            <dl className="mock-summary-grid">
              <div>
                <dt>Direct children</dt>
                <dd>{folderSummary.directChildren.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Files below</dt>
                <dd>{folderSummary.fileCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Folders below</dt>
                <dd>{folderSummary.folderCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Import links</dt>
                <dd>{folderSummary.importCount.toLocaleString()}</dd>
              </div>
            </dl>
          </Module>
        )}

        {overlayStatus === 'loading' && (
          <div className="mock-alert" role="status">
            <strong>Loading available context</strong>
            Checking dependencies, descriptions, features, guidance, activity,
            and linked work. Empty conclusions are withheld until this finishes.
          </div>
        )}
        {overlayStatus === 'error' && (
          <div className="mock-alert mock-alert-danger" role="alert">
            <strong>Node context unavailable</strong>
            The graph remains usable. Retry this node&apos;s metadata request.
            <div className="mock-alert-actions">
              <button
                type="button"
                className="mock-btn mock-btn-secondary mock-btn-sm"
                onClick={reloadOverlay}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {overlay !== null && (
          <>
            <p className="mock-context-availability">
              {populatedModuleCount} of {orderedModules.length} context areas
              currently contain data. Closed sections are unavailable or empty,
              not proof that no activity or guidance exists.
            </p>
            {orderedModules.map((definition) => {
              const Renderer = nodeModuleRenderers[definition.id];
              const hasData = moduleHasData(definition.id, overlay);
              return (
                <Renderer
                  key={definition.id}
                  definition={{ ...definition, defaultOpen: hasData }}
                  node={node}
                  overlay={overlay}
                  semanticsUsable={semanticsUsable}
                  currentView={navigation.viewId as 'technical' | 'product' | 'onboarding'}
                  selectNode={selection.selectNode}
                  openNodeInTechnical={(nodeId) => {
                    selection.selectNode(nodeId);
                    navigation.selectView('technical');
                    navigation.setFileTreeOpen(true);
                  }}
                  openFeature={(featureId) => {
                    navigation.selectView('product');
                    selection.selectFeature(featureId);
                  }}
                />
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}

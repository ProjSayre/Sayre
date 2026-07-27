import type { ComponentType, Dispatch } from 'react';
import type {
  NodeModuleDefinition,
  NodeModuleId,
} from '../moduleRegistry';
import type { WorkspaceAction } from '../state';
import type { GraphNode, NodeOverlay, ViewId } from '../types';
import {
  EmptyState,
  Module,
  Reserved,
  formatTimestamp,
} from '../components/ui';
import { AgentSkillModule } from './AgentSkillModule';

export interface NodeModuleRendererProps {
  definition: NodeModuleDefinition;
  node: GraphNode;
  overlay: NodeOverlay | null;
  semanticsUsable: boolean;
  currentView: ViewId;
  dispatch: Dispatch<WorkspaceAction>;
}

function DependenciesModule({
  definition,
  dispatch,
  currentView,
  node,
  overlay,
}: NodeModuleRendererProps) {
  const dependencies = overlay?.dependencies ?? [];
  const outbound = dependencies
    .filter((dependency) => dependency.direction === 'outbound')
    .sort((left, right) => left.path.localeCompare(right.path));
  const inbound = dependencies
    .filter((dependency) => dependency.direction === 'inbound')
    .sort((left, right) => left.path.localeCompare(right.path));
  const openDependency = (nodeId: string): void => {
    if (currentView === 'technical') {
      dispatch({ type: 'selectNode', nodeId });
      return;
    }
    dispatch({
      type: 'patch',
      patch: {
        view: 'technical',
        selectedNodeId: nodeId,
        selectedFeatureId: null,
        drawerOpen: true,
        fileTreeOpen: true,
        search: '',
      },
    });
  };
  const renderGroup = (
    title: string,
    items: typeof dependencies,
  ) =>
    items.length === 0 ? null : (
      <section className="mock-dependency-group">
        <h4>
          {title} <span>{items.length}</span>
        </h4>
        <ul className="mock-list">
          {items.map((dependency) => (
            <li key={`${dependency.direction}:${dependency.nodeId}`}>
              <button
                type="button"
                className="mock-list-row"
                onClick={() => openDependency(dependency.nodeId)}
              >
                <span className="mock-row-top">
                  <span className="mock-row-title">{dependency.name}</span>
                  <span className="mock-chip">{dependency.kind}</span>
                </span>
                <span className="mock-row-sub">{dependency.path}</span>
                {currentView !== 'technical' && (
                  <span className="mock-row-meta">
                    Open in Technical Tree →
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <Module
      title={definition.title}
      count={dependencies.length}
      defaultOpen={definition.defaultOpen}
    >
      {dependencies.length === 0 ? (
        <EmptyState>
          No imports cross this {node.kind.toLowerCase()} in either direction.
        </EmptyState>
      ) : (
        <div className="mock-dependency-groups">
          {renderGroup(
            `This ${node.kind.toLowerCase()} imports`,
            outbound,
          )}
          {renderGroup(
            `Other ${inbound.length === 1 ? 'file imports' : 'files import'} this ${node.kind.toLowerCase()}`,
            inbound,
          )}
        </div>
      )}
    </Module>
  );
}

function RecentChangesModule({
  definition,
  overlay,
}: NodeModuleRendererProps) {
  const changes = overlay?.recentChanges ?? [];
  return (
    <Module
      title={definition.title}
      count={changes.length}
      defaultOpen={definition.defaultOpen}
    >
      {changes.length === 0 ? (
        <EmptyState>No commits touching this node have been ingested yet.</EmptyState>
      ) : (
        <ul className="mock-list">
          {changes.map((change) => (
            <li key={change.commitId} className="mock-list-row">
              <span className="mock-row-top">
                <span className="mock-row-title">
                  {change.message ?? 'Commit without a message'}
                </span>
                <span className="mock-chip">{change.sha}</span>
              </span>
              <span className="mock-row-meta">
                {change.authorName ?? change.authorLogin ?? 'Unknown author'} ·{' '}
                {formatTimestamp(change.timestamp)}
              </span>
              {change.pullRequestUrl !== null && (
                <span className="mock-row-sub mock-row-wrap">
                  <a
                    href={change.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {change.pullRequestTitle ?? 'View pull request'} ↗
                  </a>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Module>
  );
}

function SpecificFeaturesModule({
  definition,
  dispatch,
  overlay,
  semanticsUsable,
}: NodeModuleRendererProps) {
  const features = overlay?.specificFeatures ?? [];
  return (
    <Module
      title={definition.title}
      count={features.length}
      defaultOpen={definition.defaultOpen}
    >
      {!semanticsUsable ? (
        <EmptyState>
          Feature boundaries are unavailable for this ref. Structure and history
          are unaffected.
        </EmptyState>
      ) : features.length === 0 ? (
        <EmptyState>This node is not part of any identified feature.</EmptyState>
      ) : (
        <ul className="mock-list">
          {features.map((feature) => (
            <li key={feature.id}>
              <button
                type="button"
                className="mock-list-row"
                onClick={() =>
                  dispatch({
                    type: 'patch',
                    patch: {
                      view: 'product',
                      selectedFeatureId: feature.id,
                      selectedNodeId: null,
                      returnFeatureId: null,
                      drawerOpen: true,
                      search: '',
                    },
                  })
                }
              >
                <span className="mock-row-top">
                  <span className="mock-row-title">{feature.name}</span>
                  <span className="mock-chip">
                    {feature.team ?? 'Unassigned'}
                  </span>
                </span>
                <span className="mock-row-sub mock-row-wrap">
                  {feature.description ?? 'No feature description available.'}
                </span>
                <span className="mock-row-meta">Open feature map →</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Module>
  );
}

function AgentSkillMdModule({
  definition,
  node,
  overlay,
}: NodeModuleRendererProps) {
  return (
    <AgentSkillModule
      overlay={overlay}
      nodeId={node.id}
      nodeName={node.name}
      title={definition.title}
      defaultOpen={definition.defaultOpen}
    />
  );
}

function DescriptionModule({
  definition,
  overlay,
  semanticsUsable,
}: NodeModuleRendererProps) {
  return (
    <Module
      title={definition.title}
      defaultOpen={definition.defaultOpen}
    >
      {!semanticsUsable ? (
        <EmptyState>
          Descriptions are unavailable for this ref while semantic features are
          down.
        </EmptyState>
      ) : overlay?.description == null ? (
        <EmptyState>No description has been generated for this node yet.</EmptyState>
      ) : (
        <p className="mock-prose">{overlay.description}</p>
      )}
    </Module>
  );
}

function SpecificTicketsModule({
  definition,
  overlay,
}: NodeModuleRendererProps) {
  const tickets = overlay?.specificTickets ?? [];
  return (
    <Module
      title={definition.title}
      count={tickets.length}
      defaultOpen={definition.defaultOpen}
    >
      {tickets.length === 0 ? (
        <EmptyState>No linked Jira or Linear issues.</EmptyState>
      ) : (
        <ul className="mock-list">
          {tickets.map((ticket) => (
            <li key={ticket.id} className="mock-list-row">
              <span className="mock-row-top">
                <span className="mock-row-title">
                  {ticket.title ?? ticket.externalId}
                </span>
                <span className="mock-chip">{ticket.status ?? 'Unknown'}</span>
              </span>
              <span className="mock-row-meta">
                {ticket.system} · {ticket.externalId}
              </span>
              {ticket.url !== null && (
                <span className="mock-row-sub">
                  <a
                    href={ticket.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open in {ticket.system} ↗
                  </a>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Module>
  );
}

function StandardsModule({ definition }: NodeModuleRendererProps) {
  return (
    <Module
      title={definition.title}
      defaultOpen={definition.defaultOpen}
    >
      <Reserved>
        Coding style, comment style, inheritance source, and node overrides will
        appear here once the resolved-style route is browser-accessible.
      </Reserved>
    </Module>
  );
}

/**
 * Every registered module must have one renderer. That exhaustiveness is the
 * extension seam for generated presets: ordering lives in the manifest, while
 * behavior remains an audited component rather than executable user input.
 */
export const nodeModuleRenderers: Readonly<
  Record<NodeModuleId, ComponentType<NodeModuleRendererProps>>
> = Object.freeze({
  dependencies: DependenciesModule,
  'recent-changes': RecentChangesModule,
  'specific-features': SpecificFeaturesModule,
  'agent-skill-md': AgentSkillMdModule,
  description: DescriptionModule,
  'specific-tickets': SpecificTicketsModule,
  standards: StandardsModule,
});

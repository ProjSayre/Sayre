import type { ComponentType, Dispatch } from 'react';
import type {
  NodeModuleDefinition,
  NodeModuleId,
} from '../moduleRegistry';
import type { WorkspaceAction } from '../state';
import type { GraphNode, NodeOverlay } from '../types';
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
  dispatch: Dispatch<WorkspaceAction>;
}

function DependenciesModule({
  definition,
  dispatch,
  node,
  overlay,
}: NodeModuleRendererProps) {
  const dependencies = overlay?.dependencies ?? [];
  const sorted = [...dependencies].sort((left, right) =>
    left.direction === right.direction
      ? left.path.localeCompare(right.path)
      : left.direction === 'outbound'
        ? -1
        : 1,
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
        <ul className="mock-list">
          {sorted.map((dependency) => (
            <li key={`${dependency.direction}:${dependency.nodeId}`}>
              <button
                type="button"
                className="mock-list-row"
                onClick={() =>
                  dispatch({ type: 'selectNode', nodeId: dependency.nodeId })
                }
              >
                <span className="mock-row-top">
                  <span className="mock-row-title">{dependency.name}</span>
                  <span
                    className={`mock-chip mock-chip-${
                      dependency.direction === 'outbound' ? 'out' : 'in'
                    }`}
                  >
                    {dependency.direction === 'outbound'
                      ? 'imports'
                      : 'imported by'}
                  </span>
                </span>
                <span className="mock-row-sub">{dependency.path}</span>
                <span className="mock-row-meta">{dependency.kind}</span>
              </button>
            </li>
          ))}
        </ul>
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
              <div className="mock-list-row">
                <span className="mock-row-top">
                  <span className="mock-row-title">{feature.name}</span>
                  <span className="mock-chip">
                    {feature.team ?? 'Unassigned'}
                  </span>
                </span>
                <span className="mock-row-sub mock-row-wrap">
                  {feature.description ?? 'No feature description available.'}
                </span>
              </div>
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

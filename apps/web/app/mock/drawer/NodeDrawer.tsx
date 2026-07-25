'use client';

import { FEATURES, GRAPH_NODES, NODE_OVERLAYS } from '../fixtures';
import { useMock } from '../state';
import type { NodeOverlay } from '../types';
import { EmptyState, Module, Reserved, formatTimestamp } from '../components/ui';
import { AgentSkillModule } from './AgentSkillModule';
import { dependenciesFor } from './dependencies';

const NODES_BY_ID = new Map(GRAPH_NODES.map((node) => [node.id, node]));

export function NodeDrawer() {
  const { state, dispatch, semanticState } = useMock();
  const node =
    state.selectedNodeId === null ? null : NODES_BY_ID.get(state.selectedNodeId);

  if (node === undefined || node === null) return null;

  const overlay: NodeOverlay | null = NODE_OVERLAYS[node.id] ?? null;
  const dependencies = dependenciesFor(node.id);
  const outbound = dependencies.filter((item) => item.direction === 'outbound');
  const inbound = dependencies.filter((item) => item.direction === 'inbound');
  const features = FEATURES.filter((feature) => feature.fileIds.includes(node.id));
  const semanticsUsable = semanticState.status !== 'failed';

  return (
    <aside className="mock-drawer" aria-label={`Details for ${node.path}`}>
      <div className="mock-drawer-header">
        <div className="mock-drawer-heading">
          <span className="mock-drawer-kind">{node.kind}</span>
          <h2>{node.name}</h2>
          <p className="mock-drawer-path">{node.path}</p>
        </div>
        <button
          type="button"
          className="mock-btn mock-btn-ghost"
          aria-label="Close details"
          onClick={() => dispatch({ type: 'closeDrawer' })}
        >
          ✕
        </button>
      </div>

      <div className="mock-drawer-scroll">
        <Module title="Dependencies" count={dependencies.length}>
          {dependencies.length === 0 ? (
            <EmptyState>
              No imports cross this {node.kind.toLowerCase()} in either direction.
            </EmptyState>
          ) : (
            <ul className="mock-list">
              {[...outbound, ...inbound].map((dependency) => (
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
                        {dependency.direction === 'outbound' ? 'imports' : 'imported by'}
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

        <Module title="Recent Changes" count={overlay?.recentChanges.length ?? 0}>
          {overlay === null || overlay.recentChanges.length === 0 ? (
            <EmptyState>No commits touching this node have been ingested yet.</EmptyState>
          ) : (
            <ul className="mock-list">
              {overlay.recentChanges.map((change) => (
                <li key={change.sha} className="mock-list-row">
                  <span className="mock-row-top">
                    <span className="mock-row-title">{change.message}</span>
                    <span className="mock-chip">{change.sha}</span>
                  </span>
                  <span className="mock-row-meta">
                    {change.authorName} · {formatTimestamp(change.timestamp)}
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

        <Module title="Specific Features" count={features.length}>
          {!semanticsUsable ? (
            <EmptyState>
              Feature boundaries are unavailable for this ref. Structure and
              history above are unaffected.
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
                      dispatch({ type: 'selectFeature', featureId: feature.id })
                    }
                  >
                    <span className="mock-row-top">
                      <span className="mock-row-title">{feature.name}</span>
                      <span className="mock-chip">{feature.team}</span>
                    </span>
                    <span className="mock-row-sub mock-row-wrap">{feature.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Module>

        <AgentSkillModule overlay={overlay} nodeName={node.name} />

        <Module title="Description">
          {!semanticsUsable ? (
            <EmptyState>
              Descriptions are unavailable for this ref while semantic features
              are down.
            </EmptyState>
          ) : overlay?.description == null ? (
            <EmptyState>
              No description has been generated for this node yet.
            </EmptyState>
          ) : (
            <p className="mock-prose">{overlay.description}</p>
          )}
        </Module>

        <Module title="Specific Tickets" count={overlay?.tickets.length ?? 0}>
          {overlay === null || overlay.tickets.length === 0 ? (
            <EmptyState>No linked Jira or Linear issues.</EmptyState>
          ) : (
            <ul className="mock-list">
              {overlay.tickets.map((ticket) => (
                <li key={ticket.externalId} className="mock-list-row">
                  <span className="mock-row-top">
                    <span className="mock-row-title">{ticket.title}</span>
                    <span className="mock-chip">{ticket.status}</span>
                  </span>
                  <span className="mock-row-meta">
                    {ticket.provider} · {ticket.externalId}
                  </span>
                  <span className="mock-row-sub">
                    <a href={ticket.url} target="_blank" rel="noreferrer noopener">
                      Open in {ticket.provider === 'jira' ? 'Jira' : 'Linear'} ↗
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Module>

        {/* Reserved slot: the backend resolves effective style rules and their
            inheritance source, but there is no browser route for it yet. */}
        <Module title="Standards" defaultOpen={false}>
          <Reserved>
            Coding style, comment style, the node these rules are inherited from,
            and whether this node overrides them will appear here once the
            resolved-style route is exposed to the browser.
          </Reserved>
        </Module>
      </div>
    </aside>
  );
}

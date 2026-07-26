'use client';

import { useMock } from '../state';
import { EmptyState, Module, formatTimestamp } from '../components/ui';

export function FeatureDrawer() {
  const { state, dispatch, graph } = useMock();
  const feature = graph.features.find(
    (item) => item.id === state.selectedFeatureId,
  );
  if (feature === undefined) return null;

  return (
    <aside className="mock-drawer" aria-label={`Details for ${feature.name}`}>
      <div className="mock-drawer-header">
        <div className="mock-drawer-heading">
          <span className="mock-drawer-kind">Feature</span>
          <h2>{feature.name}</h2>
          <p className="mock-drawer-path">{feature.team ?? 'Unassigned team'}</p>
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
        <Module title="Description">
          <p className="mock-prose">
            {feature.description ?? 'No feature description is available yet.'}
          </p>
        </Module>

        <Module title="Owning team">
          <p className="mock-prose">{feature.team ?? 'No team assigned.'}</p>
        </Module>

        <Module title="Files included" count={feature.memberIds.length}>
          <ul className="mock-list">
            {feature.memberIds.map((fileId) => {
              const file = graph.nodes.find((node) => node.id === fileId);
              if (file === undefined) return null;
              return (
                <li key={fileId}>
                  <button
                    type="button"
                    className="mock-list-row"
                    onClick={() => dispatch({ type: 'selectNode', nodeId: fileId })}
                  >
                    <span className="mock-row-top">
                      <span className="mock-row-title">{file.name}</span>
                      <span className="mock-chip">{file.kind}</span>
                    </span>
                    <span className="mock-row-sub">{file.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Module>

        <Module title="Recent edits" count={feature.recentEdits.length}>
          {feature.recentEdits.length === 0 ? (
            <EmptyState>No edits to this feature have been ingested yet.</EmptyState>
          ) : (
            <ul className="mock-list">
              {feature.recentEdits.map((edit) => (
                <li key={`${edit.filePath}:${edit.editedAt}`} className="mock-list-row">
                  <span className="mock-row-top">
                    <span className="mock-row-title">{edit.filePath}</span>
                  </span>
                  <span className="mock-row-meta">
                    {edit.editorName ?? edit.editorLogin ?? 'Unknown editor'} ·{' '}
                    {formatTimestamp(edit.editedAt)}
                  </span>
                  {edit.pullRequestUrl !== null && (
                    <span className="mock-row-sub mock-row-wrap">
                      <a
                        href={edit.pullRequestUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {edit.pullRequestTitle ?? 'View pull request'} ↗
                      </a>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Module>
      </div>
    </aside>
  );
}

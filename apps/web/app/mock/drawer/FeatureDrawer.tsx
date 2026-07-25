'use client';

import { FEATURES, GRAPH_NODES } from '../fixtures';
import { useMock } from '../state';
import { EmptyState, Module, formatTimestamp } from '../components/ui';

const NODES_BY_ID = new Map(GRAPH_NODES.map((node) => [node.id, node]));

export function FeatureDrawer() {
  const { state, dispatch } = useMock();
  const feature = FEATURES.find((item) => item.id === state.selectedFeatureId);
  if (feature === undefined) return null;

  return (
    <aside className="mock-drawer" aria-label={`Details for ${feature.name}`}>
      <div className="mock-drawer-header">
        <div className="mock-drawer-heading">
          <span className="mock-drawer-kind">Feature</span>
          <h2>{feature.name}</h2>
          <p className="mock-drawer-path">{feature.team}</p>
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
          <p className="mock-prose">{feature.description}</p>
        </Module>

        <Module title="Owning team">
          <p className="mock-prose">{feature.team}</p>
        </Module>

        <Module title="Files included" count={feature.fileIds.length}>
          <ul className="mock-list">
            {feature.fileIds.map((fileId) => {
              const file = NODES_BY_ID.get(fileId);
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
                    {edit.editorName} · {formatTimestamp(edit.editedAt)}
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

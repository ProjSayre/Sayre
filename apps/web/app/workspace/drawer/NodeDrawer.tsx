'use client';

import { useMock } from '../state';
import { nodeModules } from '../moduleRegistry';
import { nodeModuleRenderers } from './nodeModuleRenderers';

export function NodeDrawer() {
  const {
    dispatch,
    graph,
    nodeOverlay,
    overlayStatus,
    reloadOverlay,
    semanticState,
    state,
  } = useMock();
  const node =
    state.selectedNodeId === null
      ? null
      : graph.nodes.find((candidate) => candidate.id === state.selectedNodeId);

  if (node === undefined || node === null) return null;

  const overlay = nodeOverlay?.nodeId === node.id ? nodeOverlay : null;
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
        {overlayStatus === 'loading' && (
          <div className="mock-alert" role="status">
            <strong>Loading node context</strong>
            Dependencies, history, feature, and ticket modules are loading from
            the authorized graph projection.
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

        {nodeModules.map((definition) => {
          const Renderer = nodeModuleRenderers[definition.id];
          return (
            <Renderer
              key={definition.id}
              definition={definition}
              node={node}
              overlay={overlay}
              semanticsUsable={semanticsUsable}
              dispatch={dispatch}
            />
          );
        })}
      </div>
    </aside>
  );
}

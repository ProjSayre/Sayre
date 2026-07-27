'use client';

import { useMock } from '../state';
import { workspaceViews } from '../viewRegistry';

export function ViewRail() {
  const { state, dispatch } = useMock();

  const switchView = (viewId: typeof state.view): void => {
    if (viewId === state.view) return;
    dispatch({
      type: 'patch',
      patch:
        viewId === 'technical'
          ? {
              view: viewId,
              selectedFeatureId: null,
              drawerOpen:
                state.selectedNodeId !== null && state.drawerOpen,
              search: '',
            }
          : {
              view: viewId,
              selectedNodeId: null,
              selectedFeatureId: null,
              returnFeatureId: null,
              drawerOpen: false,
              search: '',
            },
    });
  };

  return (
    <nav className="mock-rail" aria-label="Workspace navigation">
      <button
        type="button"
        className="mock-rail-item"
        title="Repository explorer"
        aria-label="Repository explorer"
        aria-pressed={state.view === 'technical' && state.fileTreeOpen}
        onClick={() =>
          dispatch({
            type: 'patch',
            patch:
              state.view === 'technical'
                ? { fileTreeOpen: !state.fileTreeOpen }
                : {
                    view: 'technical',
                    fileTreeOpen: true,
                    selectedFeatureId: null,
                    drawerOpen:
                      state.selectedNodeId !== null && state.drawerOpen,
                    search: '',
                  },
          })
        }
      >
        <span className="mock-rail-glyph">F</span>
        <span className="mock-rail-label">Files</span>
      </button>

      <span className="mock-rail-divider" />

      {workspaceViews.map((view) => (
        <button
          key={view.id}
          type="button"
          className="mock-rail-item"
          title={view.hint}
          aria-label={view.label}
          aria-current={state.view === view.id ? 'page' : undefined}
          disabled={!view.enabled}
          onClick={() => switchView(view.id)}
        >
          <span className="mock-rail-glyph">{view.glyph}</span>
          <span className="mock-rail-label">
            {view.id === 'technical'
              ? 'Tech'
              : view.id === 'onboarding'
                ? 'Start'
                : view.label}
          </span>
        </button>
      ))}

      <span className="mock-rail-spacer" />
    </nav>
  );
}

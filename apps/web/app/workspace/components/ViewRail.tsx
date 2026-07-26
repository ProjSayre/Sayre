'use client';

import { useMock } from '../state';
import { workspaceViews } from '../viewRegistry';

export function ViewRail() {
  const { state, dispatch } = useMock();

  return (
    <nav className="mock-rail" aria-label="Graph views">
      {workspaceViews.map((view) => (
        <button
          key={view.id}
          type="button"
          className="mock-rail-item"
          title={view.hint}
          aria-label={view.label}
          aria-current={state.view === view.id ? 'page' : undefined}
          disabled={!view.enabled}
          onClick={() =>
            dispatch({
              type: 'patch',
              patch: { view: view.id, selectedFeatureId: null, drawerOpen: false },
            })
          }
        >
          {view.glyph}
        </button>
      ))}

      <span className="mock-rail-divider" />

      {/* Slot kept open for views this shell can host later without a
          user-facing view builder in the MVP. */}
      <span
        className="mock-rail-slot"
        title="Reserved for additional views"
        aria-hidden="true"
      >
        +
      </span>

      <span className="mock-rail-spacer" />
    </nav>
  );
}

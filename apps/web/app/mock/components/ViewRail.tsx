'use client';

import { useMock } from '../state';
import type { ViewId } from '../types';

interface RailView {
  id: ViewId;
  glyph: string;
  label: string;
  hint: string;
  enabled: boolean;
}

const VIEWS: RailView[] = [
  {
    id: 'technical',
    glyph: 'T',
    label: 'Technical',
    hint: 'Technical Tree — folders, files, imports',
    enabled: true,
  },
  {
    id: 'product',
    glyph: 'P',
    label: 'Product',
    hint: 'Product Tree — feature boundaries across files',
    enabled: true,
  },
  {
    id: 'onboarding',
    glyph: 'O',
    label: 'Onboarding',
    hint: 'Onboarding Tree — reserved, not part of the MVP',
    enabled: false,
  },
];

export function ViewRail() {
  const { state, dispatch } = useMock();

  return (
    <nav className="mock-rail" aria-label="Graph views">
      {VIEWS.map((view) => (
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

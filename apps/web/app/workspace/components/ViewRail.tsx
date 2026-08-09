'use client';

import { useWorkspaceNavigation } from '../state';
import { useResolvedWorkspace } from '../packs/WorkspacePackProvider';
import type { ViewId } from '../types';

export function ViewRail() {
  const navigation = useWorkspaceNavigation();
  const workspace = useResolvedWorkspace();
  const technicalAvailable = workspace.views.some((view) => view.id === 'technical' && view.available);

  const switchView = (viewId: ViewId): void => {
    if (viewId === navigation.viewId) return;
    navigation.selectView(viewId);
  };

  return (
    <nav className="mock-rail" aria-label="Workspace navigation">
      <button
        type="button"
        className="mock-rail-item"
        title="Repository explorer"
        aria-label="Repository explorer"
        disabled={!technicalAvailable}
        aria-pressed={navigation.viewId === 'technical' && navigation.fileTreeOpen}
        onClick={navigation.toggleTechnicalExplorer}
      >
        <span className="mock-rail-glyph">F</span>
        <span className="mock-rail-label">Files</span>
      </button>

      <span className="mock-rail-divider" />

      {workspace.views.map((view) => (
        <button
          key={view.id}
          type="button"
          className="mock-rail-item"
          title={view.hint}
          aria-label={view.id === 'technical'
            ? 'Technical Tree'
            : view.id === 'product'
              ? 'Product Tree'
              : view.id === 'onboarding'
                ? 'Onboarding Tree'
                : view.label}
          aria-current={navigation.viewId === view.id ? 'page' : undefined}
          disabled={!view.available}
          onClick={() => switchView(view.id as ViewId)}
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

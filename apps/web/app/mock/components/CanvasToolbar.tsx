'use client';

import { useReactFlow } from '@xyflow/react';
import { useMock } from '../state';

interface CanvasToolbarProps {
  title: string;
  visibleNodeCount: number;
  edgeCount: number | null;
  /** Controls are inert whenever no graph is on screen. */
  interactive: boolean;
  showMinimap: boolean;
  onToggleMinimap: () => void;
}

/** Renderer choice is a scale decision, surfaced so the reviewer can see it. */
function rendererFor(visibleNodeCount: number): string {
  return visibleNodeCount > 500 ? 'sigma · webgl' : 'react flow';
}

export function CanvasToolbar({
  title,
  visibleNodeCount,
  edgeCount,
  interactive,
  showMinimap,
  onToggleMinimap,
}: CanvasToolbarProps) {
  const { state, dispatch } = useMock();
  const flow = useReactFlow();

  return (
    <div className="mock-toolbar">
      <span className="mock-toolbar-title">
        <h1>{title}</h1>
        <span className="mock-toolbar-count">
          {visibleNodeCount} nodes
          {edgeCount === null ? '' : ` · ${edgeCount} edges`} ·{' '}
          {rendererFor(visibleNodeCount)}
        </span>
      </span>

      <span className="mock-topbar-spacer" />

      <input
        className="mock-search"
        type="search"
        value={state.search}
        placeholder="filter loaded nodes…"
        aria-label="Filter the nodes already loaded on this canvas"
        disabled={!interactive}
        onChange={(event) =>
          dispatch({ type: 'patch', patch: { search: event.target.value } })
        }
      />

      <span className="mock-toolbar-group">
        <button
          type="button"
          className="mock-icon-btn"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!interactive}
          onClick={() => flow.zoomOut()}
        >
          −
        </button>
        <button
          type="button"
          className="mock-icon-btn"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={!interactive}
          onClick={() => flow.zoomIn()}
        >
          +
        </button>
        <button
          type="button"
          className="mock-icon-btn"
          aria-label="Fit graph to view"
          title="Fit to view"
          disabled={!interactive}
          onClick={() => flow.fitView({ padding: 0.1, maxZoom: 1 })}
        >
          ⤢
        </button>
        <button
          type="button"
          className="mock-icon-btn"
          aria-label="Toggle minimap"
          title="Minimap"
          aria-pressed={showMinimap}
          disabled={!interactive}
          onClick={onToggleMinimap}
        >
          ▦
        </button>
      </span>
    </div>
  );
}

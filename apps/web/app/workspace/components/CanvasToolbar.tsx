'use client';

import { useMock } from '../state';
import type {
  CanvasCommandType,
  RendererDefinition,
} from '../rendererRegistry';

interface CanvasToolbarProps {
  title: string;
  visibleNodeCount: number;
  edgeCount: number | null;
  renderer: RendererDefinition;
  coverageSummary?: {
    pass: number;
    fail: number;
    stale: number;
    unknown: number;
  } | null;
  /** Controls are inert whenever no graph is on screen. */
  interactive: boolean;
  showMinimap: boolean;
  onToggleMinimap: () => void;
  onCommand: (command: CanvasCommandType) => void;
}

export function CanvasToolbar({
  title,
  visibleNodeCount,
  edgeCount,
  renderer,
  coverageSummary = null,
  interactive,
  showMinimap,
  onToggleMinimap,
  onCommand,
}: CanvasToolbarProps) {
  const { state, dispatch } = useMock();

  return (
    <div className="mock-toolbar">
      <span className="mock-toolbar-title">
        <h1>{title}</h1>
        <span className="mock-toolbar-count">
          {visibleNodeCount} nodes
          {edgeCount === null ? '' : ` · ${edgeCount} edges`} ·{' '}
          {renderer.label}
        </span>
      </span>

      {coverageSummary !== null && (
        <span className="mock-coverage-summary" aria-label="Test coverage status">
          {(
            [
              ['pass', coverageSummary.pass],
              ['fail', coverageSummary.fail],
              ['stale', coverageSummary.stale],
              ['unknown', coverageSummary.unknown],
            ] as const
          ).map(([status, count]) => (
            <span key={status} className={`mock-coverage-${status}`}>
              {status === 'unknown' ? 'unmeasured' : status} {count}
            </span>
          ))}
        </span>
      )}

      <span className="mock-topbar-spacer" />

      <input
        className="mock-search"
        type="search"
        value={state.search}
        placeholder="find loaded nodes…"
        aria-label="Find nodes already loaded on this canvas"
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
          onClick={() => onCommand('zoom-out')}
        >
          −
        </button>
        <button
          type="button"
          className="mock-icon-btn"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={!interactive}
          onClick={() => onCommand('zoom-in')}
        >
          +
        </button>
        <button
          type="button"
          className="mock-icon-btn"
          aria-label="Fit graph to view"
          title="Fit to view"
          disabled={!interactive}
          onClick={() => onCommand('fit')}
        >
          ⤢
        </button>
        <button
          type="button"
          className="mock-icon-btn"
          aria-label="Toggle minimap"
          title="Minimap"
          aria-pressed={showMinimap}
          disabled={!interactive || !renderer.supportsMinimap}
          onClick={onToggleMinimap}
        >
          ▦
        </button>
      </span>
    </div>
  );
}

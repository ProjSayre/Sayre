'use client';

import { useMock } from '../state';
import type {
  CanvasCommandType,
  RendererDefinition,
} from '../rendererRegistry';
import type {
  TechnicalExpansionMode,
  TechnicalTransientReveal,
} from '../technicalExpansion';

interface TechnicalExpansionControl {
  mode: TechnicalExpansionMode;
  totalNodeCount: number;
  budget: number;
  foldedBranchCount: number;
  transientMatchCount: number;
  visibleTransientMatchCount: number;
  transientSource: TechnicalTransientReveal['source'] | null;
  overBudgetBy: number;
  onModeChange: (mode: TechnicalExpansionMode) => void;
  onReset: () => void;
}

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
  technicalExpansion?: TechnicalExpansionControl | null;
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
  technicalExpansion = null,
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
          {technicalExpansion === null
            ? `${visibleNodeCount} nodes`
            : `${visibleNodeCount} / ${technicalExpansion.totalNodeCount} nodes`}
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
          )
            .filter(([, count]) => count > 0)
            .map(([status, count]) => (
              <span key={status} className={`mock-coverage-${status}`}>
                {status === 'unknown' ? 'unmeasured' : status} {count}
              </span>
            ))}
        </span>
      )}

      <span className="mock-topbar-spacer" />

      {technicalExpansion !== null && (
        <span
          className="mock-expansion-controls"
          title={`Adaptive viewport budget: ${technicalExpansion.budget} nodes${
            technicalExpansion.overBudgetBy > 0
              ? technicalExpansion.mode === 'full'
                ? ` · Full graph intentionally renders ${technicalExpansion.overBudgetBy} nodes beyond it`
                : ` · ${technicalExpansion.overBudgetBy} protected nodes over budget`
              : ''
          }`}
        >
          <select
            className="mock-expansion-mode"
            aria-label="Graph expansion mode"
            value={technicalExpansion.mode}
            disabled={!interactive}
            onChange={(event) =>
              technicalExpansion.onModeChange(
                event.target.value as TechnicalExpansionMode,
              )
            }
          >
            <option value="balanced">Balanced</option>
            <option value="focus">Focus</option>
            <option value="full">Full graph</option>
          </select>
          <button
            type="button"
            className="mock-icon-btn"
            aria-label="Reset graph expansion"
            title="Reset graph expansion"
            disabled={!interactive}
            onClick={technicalExpansion.onReset}
          >
            ↺
          </button>
          <span className="mock-expansion-summary" aria-live="polite">
            {technicalExpansion.transientMatchCount > 0
              ? technicalExpansion.transientSource === 'search'
                ? `${technicalExpansion.visibleTransientMatchCount}/${technicalExpansion.transientMatchCount} matches`
                : technicalExpansion.transientSource === 'agent'
                  ? 'agent reveal'
                  : 'deep link'
              : `${technicalExpansion.foldedBranchCount} folded`}
          </span>
        </span>
      )}

      <input
        className="mock-search"
        type="search"
        value={state.search}
        placeholder="find authorized nodes…"
        aria-label="Find authorized repository nodes"
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

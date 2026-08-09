import type { WorkspaceSlotId } from '../../../../../packages/workspace-packs/src/runtime';

export interface WorkspaceDragTarget {
  id: string;
  slot: WorkspaceSlotId;
  order: number;
}

export interface WorkspaceDragState {
  phase: 'idle' | 'dragging';
  regionId: string | null;
  activeTargetId: string | null;
  originFocusId: string | null;
  scopeKey: string | null;
  announcement: string;
}

interface BeginWorkspaceDragOptions {
  originFocusId?: string | null;
  scopeKey?: string | null;
}

function targetLabel(target: WorkspaceDragTarget): string {
  return `${target.slot} position ${target.order + 1}`;
}

export function beginWorkspaceDrag(
  regionId: string,
  options: BeginWorkspaceDragOptions = {},
): WorkspaceDragState {
  return {
    phase: 'dragging',
    regionId,
    activeTargetId: null,
    originFocusId: options.originFocusId ?? `workspace-region-handle:${regionId}`,
    scopeKey: options.scopeKey ?? null,
    announcement: `Picked up ${regionId}. Choose a drop target.`,
  };
}

export function updateWorkspaceDragTarget(
  state: WorkspaceDragState,
  targetId: string | null,
  targets: readonly WorkspaceDragTarget[],
): WorkspaceDragState {
  if (state.phase !== 'dragging') return state;
  if (targetId === null) {
    return {
      ...state,
      activeTargetId: null,
      announcement: 'Outside a compatible drop target.',
    };
  }
  const target = targets.find((candidate) => candidate.id === targetId);
  if (target === undefined) {
    return cancelWorkspaceDrag('That drop target is no longer compatible. Move cancelled.', state.originFocusId);
  }
  return {
    ...state,
    activeTargetId: target.id,
    announcement: `Drop target: ${targetLabel(target)}.`,
  };
}

export function reconcileWorkspaceDrag(
  state: WorkspaceDragState,
  input: {
    sourcePresent: boolean;
    compatibleTargets: readonly WorkspaceDragTarget[];
    scopeKey: string;
    scopeChangeAnnouncement?: string;
  },
): WorkspaceDragState {
  if (state.phase !== 'dragging') return state;
  const scopeChanged = state.scopeKey !== null && state.scopeKey !== input.scopeKey;
  const activeTargetGone = state.activeTargetId !== null
    && !input.compatibleTargets.some((target) => target.id === state.activeTargetId);
  if (scopeChanged) return cancelWorkspaceDrag(input.scopeChangeAnnouncement ?? 'The workspace scope changed. Move cancelled.', state.originFocusId);
  if (!input.sourcePresent) return cancelWorkspaceDrag('The source region is no longer available. Move cancelled.', state.originFocusId);
  if (input.compatibleTargets.length === 0) return cancelWorkspaceDrag('No compatible drop target remains. Move cancelled.', state.originFocusId);
  if (activeTargetGone) return cancelWorkspaceDrag('The selected drop target is no longer compatible. Move cancelled.', state.originFocusId);
  return state.scopeKey === null ? { ...state, scopeKey: input.scopeKey } : state;
}

export function cancelWorkspaceDrag(
  announcement = 'Move cancelled.',
  originFocusId: string | null = null,
): WorkspaceDragState {
  return {
    phase: 'idle',
    regionId: null,
    activeTargetId: null,
    originFocusId,
    scopeKey: null,
    announcement,
  };
}

export function finishWorkspaceDrag(regionId: string, target: string): WorkspaceDragState {
  return {
    phase: 'idle',
    regionId: null,
    activeTargetId: null,
    originFocusId: `workspace-region-handle:${regionId}`,
    scopeKey: null,
    announcement: `Moved ${regionId} to ${target}.`,
  };
}

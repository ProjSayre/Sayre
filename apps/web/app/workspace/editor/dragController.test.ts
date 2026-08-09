import { describe, expect, it } from 'vitest';
import * as drag from './dragController';

type Target = { id: string; slot: 'navigation' | 'explorer' | 'inspector'; order: number };
type DragState = {
  phase: 'idle' | 'dragging';
  regionId: string | null;
  activeTargetId: string | null;
  originFocusId: string | null;
  announcement: string;
};

type DragContract = typeof drag & {
  updateWorkspaceDragTarget?: (state: DragState, targetId: string | null, targets: readonly Target[]) => DragState;
  reconcileWorkspaceDrag?: (state: DragState, input: { sourcePresent: boolean; compatibleTargets: readonly Target[]; scopeKey: string }) => DragState;
};

const contract = drag as DragContract;

describe('workspace drag controller', () => {
  // @spec AC-18 EC-20
  it('models pickup, compatible target activation, and completion without browser APIs', () => {
    const targets: Target[] = [
      { id: 'navigation:0', slot: 'navigation', order: 0 },
      { id: 'explorer:1', slot: 'explorer', order: 1 },
    ];
    const picked = drag.beginWorkspaceDrag('region.explorer') as unknown as DragState;
    expect(picked).toMatchObject({ phase: 'dragging', regionId: 'region.explorer', activeTargetId: null });
    expect(contract.updateWorkspaceDragTarget).toEqual(expect.any(Function));
    const targeted = contract.updateWorkspaceDragTarget!(picked, 'navigation:0', targets);
    expect(targeted).toMatchObject({ activeTargetId: 'navigation:0' });
    expect(targeted.announcement).toMatch(/navigation/i);
    const completed = drag.finishWorkspaceDrag('region.explorer', 'navigation position 1') as unknown as DragState;
    expect(completed).toMatchObject({ phase: 'idle', regionId: null, activeTargetId: null });
    expect(completed.announcement).toMatch(/moved/i);
  });

  // @spec AC-18 EC-19 EC-20
  it('cancels stale targets and scope/source changes without emitting a move', () => {
    const picked = drag.beginWorkspaceDrag('region.inspector') as unknown as DragState;
    expect(contract.reconcileWorkspaceDrag).toEqual(expect.any(Function));
    const targetGone = contract.reconcileWorkspaceDrag!(picked, {
      sourcePresent: true,
      compatibleTargets: [],
      scopeKey: 'default:compact:member',
    });
    expect(targetGone).toMatchObject({ phase: 'idle', regionId: null, activeTargetId: null });
    expect(targetGone.announcement).toMatch(/cancel/i);

    const sourceGone = contract.reconcileWorkspaceDrag!(picked, {
      sourcePresent: false,
      compatibleTargets: [{ id: 'explorer:0', slot: 'explorer', order: 0 }],
      scopeKey: 'pitch:wide:admin',
    });
    expect(sourceGone).toMatchObject({ phase: 'idle', regionId: null });
    expect(sourceGone.announcement).toMatch(/cancel/i);
  });
});

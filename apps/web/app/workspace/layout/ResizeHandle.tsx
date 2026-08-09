'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';

export type WorkspaceResizeEdge =
  | 'inline-start'
  | 'inline-end'
  | 'block-start'
  | 'block-end';

export interface ResizeHandleProps {
  regionId: string;
  axis: 'horizontal' | 'vertical';
  edge: WorkspaceResizeEdge;
  value: number;
  minimum: number;
  maximum: number;
  collapsible: boolean;
  collapsed: boolean;
  onPreview(value: number): void;
  onCommit(value: number): void;
  onCancel(): void;
  onCollapse(): void;
  onExpand(): void;
}

interface LegacyResizeHandleProps {
  regionId: string;
  axis: 'horizontal' | 'vertical';
  edge?: WorkspaceResizeEdge;
  value: number;
  minimum: number;
  maximum: number;
  collapsible?: boolean;
  collapsed: boolean;
  onChange(value: number): void;
  onCollapse(): void;
  onExpand(): void;
}

interface ActiveResize {
  pointerId: number;
  startPosition: number;
  startValue: number;
  latestValue: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function directionFor(edge: WorkspaceResizeEdge): 1 | -1 {
  return edge === 'inline-start' || edge === 'block-start' ? -1 : 1;
}

export function ResizeHandle(props: ResizeHandleProps): ReactElement;
/** Compatibility overload for the original pre-transaction red suite. */
export function ResizeHandle(props: LegacyResizeHandleProps): ReactElement;
export function ResizeHandle(
  props: ResizeHandleProps | LegacyResizeHandleProps,
): ReactElement {
  const {
    regionId,
    axis,
    value,
    minimum,
    maximum,
    collapsed,
    onCollapse,
    onExpand,
  } = props;
  const edge = props.edge ?? (axis === 'horizontal' ? 'inline-end' : 'block-end');
  const collapsible = props.collapsible ?? true;
  const activeRef = useRef<ActiveResize | null>(null);
  const removeListenersRef = useRef<(() => void) | null>(null);
  const callbacksRef = useRef({
    preview: 'onPreview' in props ? props.onPreview : props.onChange,
    commit: 'onCommit' in props ? props.onCommit : null,
    cancel: 'onCancel' in props ? props.onCancel : null,
  });
  callbacksRef.current = {
    preview: 'onPreview' in props ? props.onPreview : props.onChange,
    commit: 'onCommit' in props ? props.onCommit : null,
    cancel: 'onCancel' in props ? props.onCancel : null,
  };

  const preview = useCallback((next: number) => {
    callbacksRef.current.preview(next);
  }, []);

  const commit = useCallback((next: number) => {
    callbacksRef.current.commit?.(next);
  }, []);

  const notifyCancel = useCallback(() => {
    callbacksRef.current.cancel?.();
  }, []);

  const removeListeners = useCallback(() => {
    removeListenersRef.current?.();
    removeListenersRef.current = null;
  }, []);

  const finish = useCallback((mode: 'commit' | 'cancel') => {
    const active = activeRef.current;
    if (active === null) return;
    activeRef.current = null;
    removeListeners();
    if (mode === 'commit') commit(active.latestValue);
    else notifyCancel();
  }, [commit, notifyCancel, removeListeners]);

  // The transaction owns window listeners across preview-driven parent renders.
  // Only unmount, not every render, cancels that transaction.
  useEffect(() => () => finish('cancel'), [finish]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsed) {
      if (collapsible) onExpand();
      return;
    }
    if (typeof window === 'undefined') return;

    finish('cancel');
    const startPosition = axis === 'horizontal' ? event.clientX : event.clientY;
    const startValue = clamp(value, minimum, maximum);
    activeRef.current = {
      pointerId: event.pointerId,
      startPosition,
      startValue,
      latestValue: startValue,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const move = (next: globalThis.PointerEvent) => {
      const active = activeRef.current;
      if (active === null || next.pointerId !== active.pointerId) return;
      const position = axis === 'horizontal' ? next.clientX : next.clientY;
      const nextValue = clamp(
        active.startValue + directionFor(edge) * (position - active.startPosition),
        minimum,
        maximum,
      );
      active.latestValue = nextValue;
      preview(nextValue);
    };
    const pointerUp = (next: globalThis.PointerEvent) => {
      if (activeRef.current === null || next.pointerId !== activeRef.current.pointerId) return;
      finish('commit');
    };
    const pointerCancel = (next: globalThis.PointerEvent) => {
      if (activeRef.current === null || next.pointerId !== activeRef.current.pointerId) return;
      finish('cancel');
    };
    const blur = () => finish('cancel');

    removeListenersRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('blur', blur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', blur);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && activeRef.current !== null) {
      event.preventDefault();
      finish('cancel');
      return;
    }
    if (event.key === 'Enter') {
      if (!collapsible) return;
      event.preventDefault();
      if (collapsed) onExpand();
      else onCollapse();
      return;
    }

    const step = event.shiftKey ? 32 : 8;
    const decreasing = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const increasing = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    let next: number | null = null;
    if (event.key === decreasing) next = value - step;
    if (event.key === increasing) next = value + step;
    if (event.key === 'Home') next = minimum;
    if (event.key === 'End') next = maximum;
    if (next === null) return;

    event.preventDefault();
    const committedValue = clamp(next, minimum, maximum);
    preview(committedValue);
    commit(committedValue);
  };

  return (
    <div
      className={`workspace-resize-handle workspace-resize-handle--${axis} workspace-resize-handle--${edge}`}
      data-resize-edge={edge}
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${regionId}`}
      aria-controls={regionId}
      aria-orientation={axis === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onPointerCancel={() => finish('cancel')}
      onLostPointerCapture={() => finish('cancel')}
      onKeyDown={onKeyDown}
    />
  );
}

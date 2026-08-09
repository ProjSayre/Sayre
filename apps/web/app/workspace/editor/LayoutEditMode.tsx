'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { WorkspacePackViolation, WorkspaceSlotId } from '../../../../../packages/workspace-packs/src/runtime';
import {
  cancelWorkspaceDrag,
  beginWorkspaceDrag,
  finishWorkspaceDrag,
  reconcileWorkspaceDrag,
  updateWorkspaceDragTarget,
  type WorkspaceDragState,
  type WorkspaceDragTarget,
} from './dragController';
import { ComponentPalette } from './ComponentPalette';
import { ThemeTokenEditor } from './ThemeTokenEditor';
import { useWorkspaceEditor } from './WorkspaceEditorProvider';
import { defaultWorkspacePack } from '../packs/builtins';
import { workspaceComponentCatalog } from '../packs/runtimeCatalog';
import { useWorkspacePack } from '../packs/WorkspacePackProvider';
import { useWorkspaceNavigation, useWorkspaceSelection } from '../state';
import './editor.css';

interface DragScope {
  pack: string;
  layout: string;
  currentView: string;
  defaultView: string;
  viewport: string;
  role: string;
  capabilities: string;
}

function dragScopeKey(scope: DragScope): string {
  return JSON.stringify(scope);
}

function scopeChangeAnnouncement(previous: DragScope | null, current: DragScope): string {
  if (previous === null) return 'The workspace scope changed. Move cancelled.';
  if (previous.pack !== current.pack) return 'The active workspace pack changed. Move cancelled.';
  if (previous.layout !== current.layout) return 'The active workspace layout changed. Move cancelled.';
  if (previous.currentView !== current.currentView || previous.defaultView !== current.defaultView) return 'The active workspace view changed. Move cancelled.';
  if (previous.viewport !== current.viewport) return 'The workspace viewport changed. Move cancelled.';
  if (previous.role !== current.role) return 'Your workspace role changed. Move cancelled.';
  if (previous.capabilities !== current.capabilities) return 'The available workspace capabilities changed. Move cancelled.';
  return 'The workspace scope changed. Move cancelled.';
}

function EditorViolations({ violations }: { violations: readonly WorkspacePackViolation[] }) {
  if (violations.length === 0) return null;
  return <>{violations.map((item) => <p role="alert" key={`${item.code}:${item.path}`}>{item.message}</p>)}</>;
}

export function LayoutEditMode({ children, systemBlocked = false }: { children: ReactNode; systemBlocked?: boolean }) {
  const editor = useWorkspaceEditor();
  const { registerInteractionCancellation } = editor;
  const packRuntime = useWorkspacePack();
  const navigation = useWorkspaceNavigation();
  const selection = useWorkspaceSelection();
  const [draggedRegion, setDraggedRegion] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [targetIndex, setTargetIndex] = useState(0);
  const [pointerGesture, setPointerGesture] = useState<{ pointerId: number } | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ regionId: string } | null>(null);
  const [forkIdentity, setForkIdentity] = useState<{ id: string; name: string; version: string; author: string } | null>(null);
  const regionHandles = useRef(new Map<string, HTMLButtonElement>());
  const restoreControls = useRef(new Map<string, HTMLButtonElement>());
  const fallbackFocusControl = useRef<HTMLButtonElement>(null);
  const dragState = useRef<WorkspaceDragState>(cancelWorkspaceDrag(''));
  const scopeAtPickup = useRef<DragScope | null>(null);
  const capturedPointer = useRef<{ pointerId: number; control: HTMLButtonElement } | null>(null);
  const dragListenerCleanup = useRef<(() => void) | null>(null);
  const suppressTargetClick = useRef(false);

  useEffect(() => {
    if (focusRequest === null) return undefined;
    const timer = setTimeout(() => {
      const control = regionHandles.current.get(focusRequest.regionId)
        ?? restoreControls.current.get(focusRequest.regionId)
        ?? fallbackFocusControl.current
        ?? (typeof document === 'undefined' ? null : document.querySelector<HTMLButtonElement>('[aria-label="Workspace controls"]'));
      control?.focus();
      setFocusRequest(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusRequest, editor.previewPack]);

  const workingPack = editor.previewPack ?? defaultWorkspacePack.pack;
  const layout = workingPack.layouts.find((item) => item.id === workingPack.defaultLayoutId) ?? workingPack.layouts[0]!;
  const dragScope = useMemo<DragScope>(() => ({
    pack: `${packRuntime.activePackRef.id}@${packRuntime.activePackRef.version}`,
    layout: `${workingPack.metadata.id}@${workingPack.metadata.version}:${layout.id}`,
    currentView: navigation.viewId,
    defaultView: workingPack.defaultViewId,
    viewport: packRuntime.viewportClass,
    role: packRuntime.role,
    capabilities: [...packRuntime.availableCapabilities].sort().join(','),
  }), [layout.id, navigation.viewId, packRuntime.activePackRef.id, packRuntime.activePackRef.version, packRuntime.availableCapabilities, packRuntime.role, packRuntime.viewportClass, workingPack.defaultViewId, workingPack.metadata.id, workingPack.metadata.version]);
  const gestureScope = dragScopeKey(dragScope);
  const dragged = layout.regions.find((region) => region.id === draggedRegion) ?? null;
  const compatibleTargets = useMemo(() => {
    if (dragged === null) return [];
    const definition = workspaceComponentCatalog.components.find((item) => item.id === dragged.component.id && item.version === dragged.component.version);
    if (definition === undefined) return [];
    return definition.allowedSlots
      .filter((slot) => slot !== 'primary' || dragged.slot === 'primary')
      .flatMap((slot) => {
        const count = layout.regions.filter((region) => region.slot === slot && region.id !== dragged.id).length;
        return Array.from({ length: count + 1 }, (_, order) => ({ slot, order, label: `${slot} position ${order + 1}` }));
      })
      .filter((target) => target.slot !== dragged.slot || target.order !== dragged.order);
  }, [dragged, layout.regions]);

  const controllerTargets = useMemo<WorkspaceDragTarget[]>(() => compatibleTargets.map((target) => ({
    id: `${target.slot}:${target.order}`,
    slot: target.slot,
    order: target.order,
  })), [compatibleTargets]);

  const clearPointerCapture = useCallback(() => {
    const capture = capturedPointer.current;
    capturedPointer.current = null;
    if (capture === null) return;
    try {
      if (capture.control.hasPointerCapture?.(capture.pointerId)) capture.control.releasePointerCapture?.(capture.pointerId);
    } catch {
      // The source may already be detached or the browser may already have released capture.
    }
  }, []);

  const clearGlobalDragListeners = useCallback(() => {
    const cleanup = dragListenerCleanup.current;
    dragListenerCleanup.current = null;
    cleanup?.();
  }, []);

  const settleCancelledDrag = useCallback((next: WorkspaceDragState) => {
    const source = dragState.current.regionId;
    dragState.current = next;
    scopeAtPickup.current = null;
    clearPointerCapture();
    clearGlobalDragListeners();
    suppressTargetClick.current = false;
    setDraggedRegion(null);
    setPointerGesture(null);
    setTargetIndex(0);
    setAnnouncement(next.announcement);
    if (source !== null) setFocusRequest({ regionId: source });
  }, [clearGlobalDragListeners, clearPointerCapture]);

  const pickUp = (regionId: string) => {
    const next = beginWorkspaceDrag(regionId, { scopeKey: gestureScope });
    dragState.current = next;
    scopeAtPickup.current = dragScope;
    setDraggedRegion(next.regionId);
    setAnnouncement(next.announcement);
    setSelectedRegionId(regionId);
    setTargetIndex(0);
  };
  const pointerPickUp = (regionId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    pickUp(regionId);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    capturedPointer.current = { pointerId: event.pointerId, control: event.currentTarget };
    setPointerGesture({ pointerId: event.pointerId });
  };
  const cancelMove = useCallback((message = 'Move cancelled.') => {
    const next = cancelWorkspaceDrag(message, dragState.current.originFocusId);
    settleCancelledDrag(next);
  }, [settleCancelledDrag]);
  const commitMove = useCallback((slot: WorkspaceSlotId, order: number) => {
    if (draggedRegion === null) return;
    const source = draggedRegion;
    const target = compatibleTargets.find((item) => item.slot === slot && item.order === order);
    if (target === undefined) {
      cancelMove('That drop target is no longer compatible. Move cancelled.');
      return;
    }
    const moved = editor.apply({ type: 'move-region', layoutId: layout.id, regionId: draggedRegion, slot, order });
    if (!moved) {
      cancelMove('That drop target is no longer compatible. Move cancelled.');
      return;
    }
    const next = finishWorkspaceDrag(source, `${slot} position ${order + 1}`);
    dragState.current = next;
    scopeAtPickup.current = null;
    clearPointerCapture();
    clearGlobalDragListeners();
    setDraggedRegion(next.regionId);
    setPointerGesture(null);
    setAnnouncement(next.announcement);
    setFocusRequest({ regionId: source });
  }, [cancelMove, clearGlobalDragListeners, clearPointerCapture, compatibleTargets, draggedRegion, editor, layout.id]);

  const cancelForSystemState = useCallback((message: string) => {
    if (dragState.current.phase === 'dragging') {
      settleCancelledDrag(cancelWorkspaceDrag(message, dragState.current.originFocusId));
      return;
    }
    clearPointerCapture();
    clearGlobalDragListeners();
    setDraggedRegion(null);
    setPointerGesture(null);
    setTargetIndex(0);
    setAnnouncement(message);
    setFocusRequest({ regionId: '' });
  }, [clearGlobalDragListeners, clearPointerCapture, settleCancelledDrag]);

  useLayoutEffect(
    () => registerInteractionCancellation(cancelForSystemState),
    [cancelForSystemState, registerInteractionCancellation],
  );

  useEffect(() => {
    if (draggedRegion === null) return;
    const source = layout.regions.find((region) => region.id === draggedRegion);
    const sourcePresent = source !== undefined
      && !source.hidden
      && (source.visibleInViews === null || source.visibleInViews.includes(navigation.viewId))
      && (regionHandles.current.size === 0 || regionHandles.current.has(draggedRegion));
    const next = reconcileWorkspaceDrag(dragState.current, {
      sourcePresent,
      compatibleTargets: controllerTargets,
      scopeKey: gestureScope,
      scopeChangeAnnouncement: scopeChangeAnnouncement(scopeAtPickup.current, dragScope),
    });
    if (next.phase === 'idle') settleCancelledDrag(next);
    else dragState.current = next;
  }, [controllerTargets, dragScope, draggedRegion, gestureScope, layout.regions, navigation.viewId, settleCancelledDrag]);

  useEffect(() => {
    if (draggedRegion === null || typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const targetFor = (event: globalThis.PointerEvent): { slot: WorkspaceSlotId; order: number } | null => {
      const element = document.elementFromPoint?.(event.clientX, event.clientY);
      const control = element?.closest<HTMLElement>('[data-workspace-drop-slot][data-workspace-drop-order]');
      if (control === null || control === undefined) return null;
      const slot = control.dataset.workspaceDropSlot as WorkspaceSlotId | undefined;
      const order = Number(control.dataset.workspaceDropOrder);
      return slot !== undefined && Number.isInteger(order) ? { slot, order } : null;
    };
    const onMove = (event: globalThis.PointerEvent) => {
      if (pointerGesture === null || event.pointerId !== pointerGesture.pointerId) return;
      const target = targetFor(event);
      if (target === null) return;
      const index = compatibleTargets.findIndex((item) => item.slot === target.slot && item.order === target.order);
      if (index >= 0) {
        dragState.current = updateWorkspaceDragTarget(dragState.current, `${target.slot}:${target.order}`, controllerTargets);
        setTargetIndex(index);
        setAnnouncement(dragState.current.announcement);
      }
    };
    const onUp = (event: globalThis.PointerEvent) => {
      if (pointerGesture === null || event.pointerId !== pointerGesture.pointerId) return;
      suppressTargetClick.current = true;
      const target = targetFor(event);
      if (target === null) cancelMove('Pointer released outside a compatible target. Move cancelled.');
      else commitMove(target.slot, target.order);
    };
    const onCancel = (event: globalThis.PointerEvent) => {
      if (pointerGesture !== null && event.pointerId === pointerGesture.pointerId) cancelMove('Pointer capture was lost. Move cancelled.');
    };
    const onBlur = () => cancelMove('Window focus was lost. Move cancelled.');
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelMove('Move cancelled with Escape.');
    };
    if (pointerGesture !== null) {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    }
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKeyDown);
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
    dragListenerCleanup.current = cleanup;
    return () => {
      cleanup();
      if (dragListenerCleanup.current === cleanup) dragListenerCleanup.current = null;
    };
  }, [cancelMove, commitMove, compatibleTargets, controllerTargets, draggedRegion, pointerGesture]);
  const keyboardMove = (regionId: string, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (draggedRegion === null) pickUp(regionId);
      else if (compatibleTargets[targetIndex]) commitMove(compatibleTargets[targetIndex]!.slot, compatibleTargets[targetIndex]!.order);
    }
    if (event.key.startsWith('Arrow') && draggedRegion !== null) {
      event.preventDefault();
      if (compatibleTargets.length === 0) setAnnouncement('No compatible drop target is available.');
      else {
        const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        const next = (targetIndex + direction + compatibleTargets.length) % compatibleTargets.length;
        const target = compatibleTargets[next]!;
        dragState.current = updateWorkspaceDragTarget(dragState.current, `${target.slot}:${target.order}`, controllerTargets);
        setTargetIndex(next);
        setAnnouncement(dragState.current.announcement);
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelMove('Move cancelled with Escape.');
    }
  };

  if (systemBlocked || !editor.editing || editor.previewPack === null) return <>{children}</>;
  const hiddenRegions = layout.regions.filter((region) => region.hidden && region.slot !== 'primary');
  const visibleRegions = layout.regions
    .filter((region) => !region.hidden)
    .toSorted((left, right) => Number(left.slot === 'primary') - Number(right.slot === 'primary'));
  const generalViolations = editor.violations.filter((item) => item.path === '' || item.path.startsWith('/metadata'));
  const themeViolations = editor.violations.filter((item) => item.path.startsWith('/theme'));
  const defaultViewViolations = editor.violations.filter((item) => item.path.startsWith('/defaultViewId') || item.path.startsWith('/views'));

  return (
    <div className="workspace-editor" data-editor-state="editing-workspace">
      <aside className="workspace-editor__toolbar" aria-label="Layout Edit Mode">
        <header className="workspace-editor__header">
          <div>
            <span className="workspace-editor__eyebrow">Layout editor</span>
            <strong>Shape your workspace</strong>
            <p>Changes stay in preview until you save. Primary and recovery controls stay protected.</p>
          </div>
        </header>
        <EditorViolations violations={generalViolations} />
        <div className="workspace-editor__actions" aria-label="Editor actions">
          <div className="workspace-editor__history-actions">
            <button type="button" disabled={!editor.canUndo} onClick={editor.undo}>Undo</button>
            <button type="button" disabled={!editor.canRedo} onClick={editor.redo}>Redo</button>
          </div>
          <button className="is-primary" type="button" onClick={editor.savePersonal}>Save personal</button>
          <button
            type="button"
            data-workspace-action="materialize-fork"
            onClick={() => setForkIdentity({
              id: `${editor.previewPack!.metadata.id}.personal`,
              name: `${editor.previewPack!.metadata.name} Personal`,
              version: '1.0.0',
              author: 'Member',
            })}
          >
            Save as reusable pack
          </button>
          <button ref={fallbackFocusControl} type="button" onClick={editor.discard}>Discard</button>
        </div>
        {forkIdentity !== null && (
          <fieldset className="workspace-editor__fork">
            <legend>New Workspace Pack identity</legend>
            {(['id', 'name', 'version', 'author'] as const).map((field) => (
              <label className="workspace-editor__field" key={field}>
                <span>{field === 'id' ? 'Pack ID' : field[0]!.toUpperCase() + field.slice(1)}</span>
                <input
                  required
                  value={forkIdentity[field]}
                  onChange={(event) => setForkIdentity({ ...forkIdentity, [field]: event.currentTarget.value })}
                />
              </label>
            ))}
            <button
              type="button"
              onClick={() => {
                const installed = editor.materializeFork(forkIdentity);
                if (installed !== null) setForkIdentity(null);
              }}
            >
              Create and activate fork
            </button>
            <button type="button" onClick={() => setForkIdentity(null)}>Cancel fork</button>
          </fieldset>
        )}
        <details className="workspace-editor__section" open>
          <summary>Regions <small>{visibleRegions.length} visible</small></summary>
          <div className="workspace-editor__section-body">
            {visibleRegions.map((region) => (
              <article className={`workspace-editor__region-control${selectedRegionId === region.id ? ' is-selected' : ''}`} key={region.id}>
                <header>
                  <div>
                    <strong>{region.slot === 'primary' ? 'Primary' : region.id.replace(/^region\./, '')}</strong>
                    <small>{region.slot}</small>
                  </div>
                  {region.slot === 'primary' && <span className="workspace-editor__locked">Locked</span>}
                </header>
                {region.slot === 'primary' ? (
                  <p className="workspace-editor__locked-copy">Primary is locked so the main graph surface always remains available.</p>
                ) : (
                  <div className="workspace-editor__region-actions">
                    <button
                      type="button"
                      ref={(element) => {
                        if (element === null) regionHandles.current.delete(region.id);
                        else regionHandles.current.set(region.id, element);
                      }}
                      aria-label={`Move ${region.id}`}
                      aria-pressed={draggedRegion === region.id}
                      onPointerDown={(event) => pointerPickUp(region.id, event)}
                      onPointerCancel={() => {
                        cancelMove('Pointer gesture was cancelled. Move cancelled.');
                      }}
                      onLostPointerCapture={() => {
                        if (capturedPointer.current !== null) cancelMove('Pointer capture was lost. Move cancelled.');
                      }}
                      onKeyDown={(event) => keyboardMove(region.id, event)}
                      onClick={() => setSelectedRegionId(region.id)}
                    >
                      Drag or reorder {region.id}
                    </button>
                    <button type="button" onClick={() => {
                      if (editor.apply({ type: 'set-region-hidden', layoutId: layout.id, regionId: region.id, hidden: true })) {
                        setSelectedRegionId(null);
                        selection.closeInspector();
                        setFocusRequest({ regionId: region.id });
                        setAnnouncement(`Hidden ${region.id}. Focus moved to its restore control.`);
                      }
                    }}>
                      Hide {region.id}
                    </button>
                  </div>
                )}
                {region.resize !== 'none' && region.slot !== 'primary' && (
                  <label className="workspace-editor__range">
                    <span>Default size <output>{region.defaultSize}px</output></span>
                    <input
                      type="range"
                      min={region.minimumSize}
                      max={region.maximumSize}
                      value={region.defaultSize}
                      onChange={(event) => editor.apply({ type: 'resize-region-default', layoutId: layout.id, regionId: region.id, size: Number(event.currentTarget.value) })}
                    />
                  </label>
                )}
                <EditorViolations violations={editor.violations.filter((item) => {
                  const layoutIndex = editor.previewPack!.layouts.findIndex((candidate) => candidate.id === layout.id);
                  const regionIndex = layout.regions.findIndex((candidate) => candidate.id === region.id);
                  return item.path.startsWith(`/layouts/${layoutIndex}/regions/${regionIndex}`);
                })} />
              </article>
            ))}
            {draggedRegion !== null && (
              <section className="workspace-editor__drop-targets" aria-label="Compatible drop targets">
                <h2>Move to</h2>
                {compatibleTargets.length === 0 ? <p>No compatible drop target.</p> : compatibleTargets.map((target, index) => (
                  <button
                    type="button"
                    key={`${target.slot}:${target.order}`}
                    data-workspace-drop-slot={target.slot}
                    data-workspace-drop-order={target.order}
                    aria-current={index === targetIndex ? 'true' : undefined}
                    onFocus={() => {
                      dragState.current = updateWorkspaceDragTarget(dragState.current, `${target.slot}:${target.order}`, controllerTargets);
                      setTargetIndex(index);
                      setAnnouncement(dragState.current.announcement);
                    }}
                    onPointerEnter={() => {
                      dragState.current = updateWorkspaceDragTarget(dragState.current, `${target.slot}:${target.order}`, controllerTargets);
                      setTargetIndex(index);
                      setAnnouncement(dragState.current.announcement);
                    }}
                    onClick={() => {
                      if (suppressTargetClick.current) {
                        suppressTargetClick.current = false;
                        return;
                      }
                      commitMove(target.slot, target.order);
                    }}
                  >
                    {target.label}
                  </button>
                ))}
              </section>
            )}
            <section className="workspace-editor__hidden" aria-label="Hidden-region restore list">
              <h2>Hidden regions</h2>
              {hiddenRegions.length === 0 ? <p>No hidden region.</p> : hiddenRegions.map((region) => (
                <button
                  key={region.id}
                  type="button"
                  ref={(element) => {
                    if (element === null) restoreControls.current.delete(region.id);
                    else restoreControls.current.set(region.id, element);
                  }}
                  onClick={() => {
                    if (editor.apply({ type: 'set-region-hidden', layoutId: layout.id, regionId: region.id, hidden: false })) {
                      setFocusRequest({ regionId: region.id });
                      setAnnouncement(`Restored ${region.id}. Focus returned to its move handle.`);
                    }
                  }}
                >
                  Restore {region.id}
                </button>
              ))}
            </section>
            {selectedRegionId !== null && (() => {
              const selected = layout.regions.find((region) => region.id === selectedRegionId);
              if (selected === undefined) return null;
              return (
                <ComponentPalette
                  catalog={workspaceComponentCatalog}
                  slot={selected.slot}
                  role={packRuntime.role}
                  capabilities={packRuntime.availableCapabilities}
                  current={selected.component}
                  onChoose={(id, version) => editor.apply({
                    type: 'replace-region-component', layoutId: layout.id, regionId: selected.id, component: { id, version },
                  })}
                />
              );
            })()}
          </div>
        </details>
        <details className="workspace-editor__section">
          <summary>Starting view</summary>
          <div className="workspace-editor__section-body">
            <label className="workspace-editor__field">
              <span>Default view</span>
              <select value={editor.previewPack.defaultViewId} onChange={(event) => editor.apply({ type: 'set-default-view', viewId: event.currentTarget.value })}>
                {editor.previewPack.views.filter((view) => view.enabled).map((view) => <option key={view.id} value={view.id}>{view.label}</option>)}
              </select>
            </label>
            <EditorViolations violations={defaultViewViolations} />
          </div>
        </details>
        <details className="workspace-editor__section">
          <summary>Appearance</summary>
          <div className="workspace-editor__section-body">
            <ThemeTokenEditor
              theme={editor.previewPack.theme}
              apply={editor.apply}
              resetColor={(token) => editor.apply({ type: 'set-theme-color', token, value: editor.draft!.basePack.theme.colors[token] })}
              resetChoice={(token) => {
                const baseTheme = editor.draft!.basePack.theme;
                if (token === 'density') editor.apply({ type: 'set-theme-choice', token, value: baseTheme.density });
                else if (token === 'radius') editor.apply({ type: 'set-theme-choice', token, value: baseTheme.radius });
                else editor.apply({ type: 'set-theme-choice', token, value: baseTheme.typography[token.split('.')[1] as 'ui' | 'mono'] });
              }}
            />
            <EditorViolations violations={themeViolations} />
          </div>
        </details>
        <footer className="workspace-editor__footer">
          <span>{workspaceComponentCatalog.components.length} trusted catalog entries</span>
          <p role="status" aria-live="polite">{announcement}</p>
        </footer>
      </aside>
      <div className="workspace-editor__preview">{children}</div>
    </div>
  );
}

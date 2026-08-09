'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useWorkspaceEditor } from '../editor/WorkspaceEditorProvider';
import { useWorkspacePack } from '../packs/WorkspacePackProvider';
import { useWorkspaceNavigation, useWorkspaceSession } from '../state';

export function SystemRecoveryMenu() {
  const session = useWorkspaceSession();
  const navigation = useWorkspaceNavigation();
  const editor = useWorkspaceEditor();
  const workspacePack = useWorkspacePack();
  const canEdit = session.session === 'authenticated'
    && session.backend === 'available'
    && session.access !== 'forbidden'
    && session.repository !== null
    && session.authorizedForRepository;
  const [open, setOpen] = useState(false);
  const [focusReturned, setFocusReturned] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activePack = workspacePack.store.get(workspacePack.activePackRef);

  const closeMenu = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) {
      setFocusReturned(true);
      triggerRef.current?.focus();
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const ownerDocument = rootRef.current?.ownerDocument ?? (typeof document === 'undefined' ? null : document);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      closeMenu(false);
    };
    ownerDocument?.addEventListener('pointerdown', onPointerDown);
    return () => ownerDocument?.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      closeMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault?.();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const current = items.indexOf((rootRef.current?.ownerDocument ?? document).activeElement as HTMLButtonElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };

  const runAndClose = (action: () => void) => {
    action();
    closeMenu(true);
  };

  return (
    <nav ref={rootRef} className="workspace-system-recovery" aria-label="Workspace recovery">
      <button
        ref={triggerRef}
        type="button"
        className="workspace-recovery__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'workspace-recovery-menu' : undefined}
        aria-label="Workspace controls"
        data-workspace-recovery-trigger="true"
        data-focus-returned={focusReturned}
        onClick={() => {
          setOpen((current) => !current);
          setFocusReturned(false);
        }}
      >
        Workspace
      </button>
      {workspacePack.experience.usedSafetyFallback && (
        <span className="workspace-recovery__status" role="status">Safety default active</span>
      )}
      {workspacePack.error !== null && !workspacePack.experience.usedSafetyFallback && (
        <span className="workspace-recovery__status" role="status">
          Default workspace active
          <span className="workspace-recovery__status-detail">{workspacePack.error}</span>
        </span>
      )}
      {editor.interruptionAnnouncement && (
        <span className="workspace-recovery__status" role="status" data-workspace-interruption-status="true">
          {editor.interruptionAnnouncement}
        </span>
      )}
      {open && (
        <div
          ref={menuRef}
          id="workspace-recovery-menu"
          className="workspace-recovery__menu"
          role="menu"
          aria-label="Workspace controls"
          data-workspace-recovery-menu="true"
          onKeyDown={onMenuKeyDown}
        >
          <header className="workspace-recovery__menu-head">
            <span>Current workspace</span>
            <strong>{activePack?.pack.metadata.name ?? 'Default workspace'}</strong>
            {activePack !== null && <small>Version {activePack.pack.metadata.version}</small>}
          </header>
          {workspacePack.experience.usedSafetyFallback && (
            <p className="workspace-recovery__notice" role="status">The safety default is active because the requested setup could not be loaded.</p>
          )}
          {workspacePack.error !== null && (
            <div className="workspace-recovery__notice workspace-recovery__notice--error" role="alert">
              <p>{workspacePack.error}</p>
              <button type="button" role="menuitem" onClick={workspacePack.dismissError}>Dismiss message</button>
            </div>
          )}
          {editor.dirty && (
            <p className="workspace-recovery__notice">Finish or discard the open layout draft before switching or resetting.</p>
          )}
          <div className="workspace-recovery__actions">
            <button type="button" role="menuitem" data-workspace-recovery-action="switch-default" disabled={editor.dirty} onClick={() => runAndClose(workspacePack.switchToDefault)}>
              Switch to default
            </button>
            <button type="button" role="menuitem" data-workspace-recovery-action="reset-layout" disabled={editor.dirty} onClick={() => runAndClose(workspacePack.resetLayout)}>
              Reset layout
            </button>
            {canEdit && !editor.editing && (
              <button type="button" role="menuitem" data-workspace-recovery-action="open-editor" onClick={() => runAndClose(editor.begin)}>
                Layout editor
              </button>
            )}
            {canEdit && editor.editing && (
              <button type="button" role="menuitem" data-workspace-recovery-action="exit-editor" onClick={() => runAndClose(editor.discard)}>
                {editor.dirty ? 'Discard draft and exit layout editor' : 'Exit layout editor'}
              </button>
            )}
            <button type="button" role="menuitem" data-workspace-recovery-action="workspace-pack-settings" onClick={() => runAndClose(() => navigation.openSettings('workspace-packs'))}>
              Workspace Pack settings
            </button>
          </div>
        </div>
      )}
      {canEdit && !editor.editing && (
        <button type="button" hidden onClick={editor.begin}>Edit workspace layout</button>
      )}
    </nav>
  );
}

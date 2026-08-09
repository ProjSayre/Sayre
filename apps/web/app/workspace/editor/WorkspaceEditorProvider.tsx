'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  applyWorkspaceEditOperation,
  canonicalizeWorkspacePack,
  validateWorkspacePackCompatibility,
  type InstalledWorkspacePack,
  type WorkspaceEditOperation,
  type WorkspacePackDocument,
  type WorkspacePackEditResult,
  type WorkspacePackOverride,
  type WorkspacePackRef,
  type WorkspacePackValidationResult,
  type WorkspacePackViolation,
  type WorkspaceRole,
} from '../../../../../packages/workspace-packs/src/runtime';
import { useWorkspacePack } from '../packs/WorkspacePackProvider';
import { validateRuntimeComponentProps, workspaceComponentCatalog } from '../packs/runtimeCatalog';

const HISTORY_LIMIT = 50;

export interface WorkspaceEditorDraft {
  baseRef: WorkspacePackRef;
  baseOverrideRevision: number;
  basePack: WorkspacePackDocument;
  operations: readonly WorkspaceEditOperation[];
  previewPack: WorkspacePackDocument;
  historyIndex: number;
  dirty: boolean;
  violations: readonly WorkspacePackViolation[];
}

export interface WorkspaceEditorActions {
  begin(ref?: WorkspacePackRef): void;
  dispatch(operation: WorkspaceEditOperation): WorkspacePackEditResult;
  undo(): void;
  redo(): void;
  discard(): void;
  savePersonal(): void;
  materializeFork(identity: { id: string; name: string; version: string; author: string }): InstalledWorkspacePack;
}

export interface WorkspaceEditorContextValue {
  mode: 'inactive' | 'editing';
  draft: WorkspaceEditorDraft | null;
  canUndo: boolean;
  canRedo: boolean;
  actions: WorkspaceEditorActions;
  /** Convenience aliases used by the current editor chrome. */
  editing: boolean;
  dirty: boolean;
  previewPack: WorkspacePackDocument | null;
  violations: readonly WorkspacePackViolation[];
  begin(): void;
  apply(operation: WorkspaceEditOperation): boolean;
  undo(): void;
  redo(): void;
  discard(): void;
  savePersonal(): void;
  materializeFork(identity: { id: string; name: string; version: string; author: string }): InstalledWorkspacePack | null;
  interruptionAnnouncement: string;
  registerInteractionCancellation(handler: (announcement: string) => void): () => void;
  interruptForSystemState(announcement: string): void;
}

interface HistoryEntry {
  pack: WorkspacePackDocument;
  operations: readonly WorkspaceEditOperation[];
}

const WorkspaceEditorContext = createContext<WorkspaceEditorContextValue | null>(null);
const roleRank: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

function personalOverrideFor(pack: WorkspacePackDocument): WorkspacePackOverride {
  return {
    theme: structuredClone(pack.theme),
    defaultLayoutId: pack.defaultLayoutId,
    defaultViewId: pack.defaultViewId,
    layouts: structuredClone(pack.layouts),
    views: structuredClone(pack.views),
  };
}

function editableDocument(pack: WorkspacePackDocument, override: WorkspacePackOverride | null): WorkspacePackDocument {
  if (override === null) return structuredClone(pack);
  return {
    ...structuredClone(pack),
    ...structuredClone(override),
    theme: {
      ...structuredClone(pack.theme),
      ...(override.theme ?? {}),
      colors: { ...pack.theme.colors, ...(override.theme?.colors ?? {}) },
      typography: { ...pack.theme.typography, ...(override.theme?.typography ?? {}) },
    },
  };
}

function validateEditorPack(
  pack: WorkspacePackDocument,
  role: WorkspaceRole,
  availableCapabilities: readonly string[],
): WorkspacePackValidationResult {
  const compatible = validateWorkspacePackCompatibility(pack, workspaceComponentCatalog);
  if (!compatible.ok) return compatible;
  const props = validateRuntimeComponentProps(compatible.pack);
  if (!props.ok) return props;
  const violations = compatible.pack.layouts.flatMap((layout, layoutIndex) =>
    layout.regions.flatMap((region, regionIndex) => {
      const definition = workspaceComponentCatalog.components.find(
        (item) => item.id === region.component.id && item.version === region.component.version,
      );
      if (definition === undefined) return [];
      const authorizedRole = definition.minimumRole === null || roleRank[role] >= roleRank[definition.minimumRole];
      const authorizedCapabilities = definition.requiredCapabilities.every((capability) => availableCapabilities.includes(capability));
      return authorizedRole && authorizedCapabilities ? [] : [{
        code: 'component-unauthorized',
        path: `/layouts/${layoutIndex}/regions/${regionIndex}/component`,
        message: 'This component is no longer authorized for the current role or active pack capabilities.',
      }];
    }),
  );
  return violations.length === 0 ? compatible : { ok: false, violations };
}

export function WorkspaceEditorProvider({ children }: { children: ReactNode }) {
  const packRuntime = useWorkspacePack();
  const { activePackRef, store } = packRuntime;
  const [base, setBase] = useState<{ ref: WorkspacePackRef; pack: WorkspacePackDocument; overrideRevision: number } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [violations, setViolations] = useState<readonly WorkspacePackViolation[]>([]);
  const [interruptionAnnouncement, setInterruptionAnnouncement] = useState('');
  const interactionCancellation = useRef<((announcement: string) => void) | null>(null);
  const current = cursor >= 0 ? history[cursor] ?? null : null;
  const previewPack = current?.pack ?? null;
  const editing = base !== null && current !== null;
  const dirty = base !== null && previewPack !== null
    && canonicalizeWorkspacePack(base.pack) !== canonicalizeWorkspacePack(previewPack);

  const begin = (ref: WorkspacePackRef = activePackRef) => {
    setInterruptionAnnouncement('');
    const installed = store.get(ref);
    if (installed === null) {
      setViolations([{ code: 'missing-pack', path: '', message: 'The selected Workspace Pack is unavailable.' }]);
      return;
    }
    const initial = editableDocument(installed.pack, store.personalOverride(ref));
    setBase({ ref: structuredClone(ref), pack: initial, overrideRevision: store.personalOverrideRevision(ref) });
    setHistory([{ pack: initial, operations: [] }]);
    setCursor(0);
    setViolations([]);
  };

  const dispatchOperation = (operation: WorkspaceEditOperation): WorkspacePackEditResult => {
    const fallback = previewPack ?? store.get(activePackRef)?.pack;
    if (fallback === undefined) throw new Error('Default Workspace Pack is unavailable.');
    if (previewPack === null || current === null) {
      return { ok: false, pack: fallback, violations: [{ code: 'editor-inactive', path: '', message: 'Enter Layout Edit Mode first.' }] };
    }
    const result = applyWorkspaceEditOperation(previewPack, operation, {
      catalog: workspaceComponentCatalog,
      role: packRuntime.role,
      availableCapabilities: packRuntime.availableCapabilities,
    });
    if (!result.ok) {
      setViolations(result.violations);
      return result;
    }
    const validated = validateEditorPack(result.pack, packRuntime.role, packRuntime.availableCapabilities);
    if (!validated.ok) {
      const rejected: WorkspacePackEditResult = { ok: false, pack: previewPack, violations: validated.violations };
      setViolations(validated.violations);
      return rejected;
    }
    if (result.changedPaths.length === 0) {
      setViolations([]);
      return result;
    }
    const branch = history.slice(1, cursor + 1);
    const accepted = {
      pack: result.pack,
      operations: [...current.operations, operation].slice(-HISTORY_LIMIT),
    };
    const next = [
      { pack: base!.pack, operations: [] },
      ...[...branch, accepted].slice(-HISTORY_LIMIT),
    ];
    setHistory(next);
    setCursor(next.length - 1);
    setViolations([]);
    return result;
  };

  const transitionHistory = (nextCursor: number) => {
    const candidate = history[nextCursor];
    if (candidate === undefined) return;
    const validated = validateEditorPack(candidate.pack, packRuntime.role, packRuntime.availableCapabilities);
    if (!validated.ok) {
      setViolations(validated.violations);
      return;
    }
    setCursor(nextCursor);
    setViolations([]);
  };
  const undo = () => transitionHistory(Math.max(0, cursor - 1));
  const redo = () => transitionHistory(Math.min(history.length - 1, cursor + 1));
  const discard = useCallback(() => {
    setBase(null);
    setHistory([]);
    setCursor(-1);
    setViolations([]);
    setInterruptionAnnouncement('');
  }, []);
  const registerInteractionCancellation = useCallback((handler: (announcement: string) => void) => {
    interactionCancellation.current = handler;
    return () => {
      if (interactionCancellation.current === handler) interactionCancellation.current = null;
    };
  }, []);
  const interruptForSystemState = useCallback((announcement: string) => {
    interactionCancellation.current?.(announcement);
    discard();
    setInterruptionAnnouncement(announcement);
  }, [discard]);
  const savePersonal = () => {
    if (previewPack === null || base === null) return;
    const validated = validateEditorPack(previewPack, packRuntime.role, packRuntime.availableCapabilities);
    if (!validated.ok) {
      setViolations(validated.violations);
      return;
    }
    try {
      store.savePersonalOverride(base.ref, personalOverrideFor(validated.pack), base.overrideRevision);
      discard();
    } catch (error) {
      setViolations([{ code: 'storage-failed', path: '', message: error instanceof Error ? error.message : 'Personal changes could not be saved.' }]);
    }
  };
  const materializeFork = (identity: { id: string; name: string; version: string; author: string }): InstalledWorkspacePack | null => {
    if (previewPack === null || base === null) return null;
    const validated = validateEditorPack(previewPack, packRuntime.role, packRuntime.availableCapabilities);
    if (!validated.ok) {
      setViolations(validated.violations);
      return null;
    }
    const forkDocument: WorkspacePackDocument = {
      ...structuredClone(validated.pack),
      metadata: { ...validated.pack.metadata, derivedFrom: base.ref },
    };
    try {
      const fork = store.forkAndActivate(base.ref, identity, forkDocument);
      discard();
      return fork;
    } catch (error) {
      setViolations([{ code: 'fork-failed', path: '/metadata', message: error instanceof Error ? error.message : 'Fork failed.' }]);
      return null;
    }
  };

  useEffect(() => store.subscribe(() => {
    if (base === null || !dirty) return;
    const actualRevision = store.personalOverrideRevision(base.ref);
    if (actualRevision !== base.overrideRevision) {
      setViolations([{
        code: 'base-revision-conflict',
        path: '',
        message: `Personal override changed from revision ${base.overrideRevision} to ${actualRevision}. Discard/reload or materialize this draft as a fork.`,
      }]);
    }
  }), [base, dirty, store]);

  useEffect(() => {
    if (base === null || (base.ref.id === activePackRef.id && base.ref.version === activePackRef.version)) return;
    if (dirty) {
      setViolations([{
        code: 'editor-base-changed',
        path: '',
        message: `The active pack changed while this draft is dirty. Discard it, save it against ${base.ref.id}@${base.ref.version}, or materialize a fork.`,
      }]);
    } else {
      discard();
    }
  }, [activePackRef.id, activePackRef.version, base, dirty, discard]);

  const draft: WorkspaceEditorDraft | null = base !== null && current !== null ? {
    baseRef: base.ref,
    baseOverrideRevision: base.overrideRevision,
    basePack: base.pack,
    operations: current.operations,
    previewPack: current.pack,
    historyIndex: cursor,
    dirty,
    violations,
  } : null;
  const actions: WorkspaceEditorActions = {
    begin,
    dispatch: dispatchOperation,
    undo,
    redo,
    discard,
    savePersonal,
    materializeFork(identity) {
      const installed = materializeFork(identity);
      if (installed === null) throw new Error('Workspace Pack fork was not materialized.');
      return installed;
    },
  };

  return (
    <WorkspaceEditorContext.Provider value={{
      mode: editing ? 'editing' : 'inactive',
      draft,
      canUndo: cursor > 0,
      canRedo: cursor >= 0 && cursor < history.length - 1,
      actions,
      editing,
      dirty,
      previewPack,
      violations,
      begin: () => begin(),
      apply: (operation) => dispatchOperation(operation).ok,
      undo,
      redo,
      discard,
      savePersonal,
      materializeFork,
      interruptionAnnouncement,
      registerInteractionCancellation,
      interruptForSystemState,
    }}>
      {children}
    </WorkspaceEditorContext.Provider>
  );
}

export function useWorkspaceEditor(): WorkspaceEditorContextValue {
  const value = useContext(WorkspaceEditorContext);
  if (value === null) throw new Error('useWorkspaceEditor must be used inside WorkspaceEditorProvider.');
  return value;
}

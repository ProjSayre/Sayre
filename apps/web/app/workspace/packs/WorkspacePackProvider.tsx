'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  resolveWorkspaceExperience,
  type ResolvedWorkspaceExperience,
  type WorkspacePackRef,
  type WorkspaceRole,
  type WorkspaceUserPreferences,
} from '../../../../../packages/workspace-packs/src/runtime';
import { builtinWorkspacePacks, defaultWorkspacePack } from './builtins';
import { createBrowserWorkspacePackStore, type WorkspacePackStore } from './packStorage';
import { workspaceComponentCatalog } from './runtimeCatalog';
import { validateRuntimeComponentProps } from './runtimeCatalog';

export type WorkspaceViewportClass = 'compact' | 'standard' | 'wide';

export interface WorkspacePackContextValue {
  store: WorkspacePackStore;
  activePackRef: WorkspacePackRef;
  role: WorkspaceRole;
  availableCapabilities: readonly string[];
  viewportClass: WorkspaceViewportClass;
  viewportPreview: WorkspaceViewportClass | null;
  setViewportPreview(value: WorkspaceViewportClass | null): void;
  experience: ResolvedWorkspaceExperience;
  error: string | null;
  dismissError(): void;
  reportRecovery(message: string): void;
  activatePack(ref: WorkspacePackRef): void;
  setRegionSize(regionId: string, value: number): void;
  setRegionCollapsed(regionId: string, value: boolean): void;
  resetLayout(): void;
  switchToDefault(): void;
}

const WorkspacePackContext = createContext<WorkspacePackContextValue | null>(null);

function viewportFor(width: number): WorkspaceViewportClass {
  if (width < 736) return 'compact';
  if (width < 1200) return 'standard';
  return 'wide';
}

function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

function createWorkspacePackStore(storage: Storage | null): WorkspacePackStore {
  return createBrowserWorkspacePackStore({
    builtins: builtinWorkspacePacks,
    storage,
    catalog: workspaceComponentCatalog,
    validateComponentProps: validateRuntimeComponentProps,
  });
}

export function WorkspacePackProvider({
  children,
  role = 'member',
  initialPackRef,
  initialPackRequest = null,
}: {
  children: ReactNode;
  role?: WorkspaceRole;
  initialPackRef?: WorkspacePackRef;
  initialPackRequest?: string | null;
}) {
  const [store, setStore] = useState<WorkspacePackStore>(() => createWorkspacePackStore(null));
  const serverSafeInitialRef = initialPackRef !== undefined
    && builtinWorkspacePacks.some((item) => item.ref.id === initialPackRef.id && item.ref.version === initialPackRef.version)
    ? initialPackRef
    : defaultWorkspacePack.ref;
  const [activePackRef, setActivePackRef] = useState<WorkspacePackRef>(serverSafeInitialRef);
  const [measuredViewportClass, setMeasuredViewportClass] = useState<WorkspaceViewportClass>('wide');
  const [viewportPreview, setViewportPreview] = useState<WorkspaceViewportClass | null>(null);
  const viewportClass = viewportPreview ?? measuredViewportClass;
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const browserStore = createWorkspacePackStore(safeStorage());
    setStore(browserStore);
    const recovery = browserStore.recoveryMessage();
    if (recovery !== null) {
      setError((current) => current ?? recovery);
    }
  }, []);

  useEffect(() => {
    if (initialPackRequest !== null) {
      if (initialPackRef === undefined) {
        setActivePackRef(defaultWorkspacePack.ref);
        setError(`Workspace Pack reference "${initialPackRequest}" is malformed. The default pack was restored.`);
        return;
      }
      if (store.get(initialPackRef) === null) {
        setActivePackRef(defaultWorkspacePack.ref);
        setError(`Workspace Pack ${initialPackRequest} is not installed or compatible. The default pack was restored.`);
        return;
      }
      try {
        store.activate(initialPackRef);
      } catch {
        // Exact query selection still works for this session when persistence is unavailable.
      }
      setActivePackRef(initialPackRef);
      return;
    }
    setActivePackRef(store.active());
  }, [initialPackRef, initialPackRequest, store]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const resize = () => setMeasuredViewportClass(viewportFor(window.innerWidth));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      const next = store.active();
      setActivePackRef(next);
      const recovery = store.recoveryMessage();
      if (recovery !== null) setError(recovery);
      setRevision((value) => value + 1);
    });
    if (typeof window === 'undefined') return unsubscribe;
    const browserStorage = safeStorage();
    const onStorage = (event: StorageEvent) => {
      if (browserStorage !== null && event.storageArea === browserStorage && event.key?.startsWith('sayre.workspace-packs.') === true) store.refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      unsubscribe();
    };
  }, [store]);

  const installed = store.get(activePackRef) ?? defaultWorkspacePack;
  const availableCapabilities = workspaceComponentCatalog.capabilities.map((item) => item.id);
  const personal = store.personalOverride(installed.ref);
  const baseLayout = installed.pack.layouts.find((item) => item.id === installed.pack.defaultLayoutId) ?? installed.pack.layouts[0]!;
  const preferenceLayoutKey = `${baseLayout.id}:${viewportClass}`;
  const storedPreferences = store.preferences(installed.ref, preferenceLayoutKey);
  const preferences = storedPreferences === null ? null : { ...storedPreferences, layoutId: baseLayout.id };
  const experience = resolveWorkspaceExperience({
    safetyDefaults: defaultWorkspacePack.pack,
    selectedPack: installed.pack,
    organizationOverride: null,
    userOverride: personal,
    userPreferences: preferences,
    catalog: workspaceComponentCatalog,
    viewportClass,
    role,
  });
  void revision;

  const savePreference = (
    regionSizes: Readonly<Record<string, number>>,
    collapsedRegionIds: readonly string[],
  ) => {
    const validIds = new Set(experience.layout.regions.map((region) => region.id));
    const cleanSizes = Object.fromEntries(Object.entries(regionSizes).filter(([id]) => validIds.has(id)));
    const next: WorkspaceUserPreferences = {
      pack: installed.ref,
      layoutId: `${experience.layout.id}:${viewportClass}`,
      regionSizes: cleanSizes,
      collapsedRegionIds: collapsedRegionIds.filter((id) => validIds.has(id)),
      updatedAt: new Date().toISOString(),
    };
    try {
      store.savePreferences(next);
      setError(null);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Layout preferences could not be saved.');
    }
  };

  const value: WorkspacePackContextValue = {
    store,
    activePackRef,
    role,
    availableCapabilities,
    viewportClass,
    viewportPreview,
    setViewportPreview,
    experience,
    error,
    dismissError: () => setError(null),
    reportRecovery: (message) => setError(message),
    activatePack(ref) {
      try {
        store.activate(ref);
        setActivePackRef(ref);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Workspace Pack could not be activated.');
      }
    },
    setRegionSize(regionId, requested) {
      const region = experience.layout.regions.find((item) => item.id === regionId);
      if (!region) return;
      const clamp = Math.min(region.maximumSize, Math.max(region.minimumSize, requested));
      savePreference({ ...(preferences?.regionSizes ?? {}), [regionId]: clamp }, preferences?.collapsedRegionIds ?? []);
    },
    setRegionCollapsed(regionId, collapsed) {
      const region = experience.layout.regions.find((item) => item.id === regionId);
      if (region === undefined || region.slot === 'primary' || !region.collapsible) return;
      const ids = new Set(preferences?.collapsedRegionIds ?? []);
      if (collapsed) ids.add(regionId); else ids.delete(regionId);
      savePreference(preferences?.regionSizes ?? {}, [...ids]);
    },
    resetLayout() {
      try {
        store.resetPreferences(installed.ref, `${experience.layout.id}:${viewportClass}`);
        setError(null);
        setRevision((value) => value + 1);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Layout preferences could not be reset.');
      }
    },
    switchToDefault() {
      try {
        store.activate(defaultWorkspacePack.ref);
        setError(null);
        setActivePackRef(defaultWorkspacePack.ref);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The default pack is available only for this session because storage is unavailable.');
        setActivePackRef(defaultWorkspacePack.ref);
      }
    },
  };

  return <WorkspacePackContext.Provider value={value}>{children}</WorkspacePackContext.Provider>;
}

export function useWorkspacePack(): WorkspacePackContextValue {
  const value = useContext(WorkspacePackContext);
  if (value === null) throw new Error('useWorkspacePack must be used inside WorkspacePackProvider.');
  return value;
}

export function useOptionalWorkspacePack(): WorkspacePackContextValue | null {
  return useContext(WorkspacePackContext);
}

export interface WorkspacePackActions {
  install(rawJson: string): ReturnType<WorkspacePackStore['install']>;
  activate(ref: WorkspacePackRef): void;
  fork(source: WorkspacePackRef, identity: { id: string; name: string; version: string; author: string }): ReturnType<WorkspacePackStore['fork']>;
  export(ref: WorkspacePackRef): string;
  uninstall(ref: WorkspacePackRef): void;
  resetLayout(layoutId?: string): void;
  resetPersonalOverride(ref?: WorkspacePackRef): void;
  switchToDefault(): void;
}

export interface WorkspaceLayoutActions {
  resize(regionId: string, size: number): void;
  collapse(regionId: string): void;
  expand(regionId: string): void;
  reset(layoutId?: string): void;
}

export function useResolvedWorkspace(): ResolvedWorkspaceExperience {
  return useWorkspacePack().experience;
}

export function useWorkspacePackActions(): WorkspacePackActions {
  const runtime = useWorkspacePack();
  return {
    install(rawJson) { return runtime.store.install(rawJson); },
    activate: runtime.activatePack,
    fork(source, identity) { return runtime.store.fork(source, identity); },
    export(ref) { return runtime.store.export(ref); },
    uninstall(ref) { runtime.store.uninstall(ref); },
    resetLayout: runtime.resetLayout,
    resetPersonalOverride(ref = runtime.activePackRef) { runtime.store.resetPersonalOverride(ref); },
    switchToDefault: runtime.switchToDefault,
  };
}

export function useWorkspaceLayoutActions(): WorkspaceLayoutActions {
  const runtime = useWorkspacePack();
  return {
    resize: runtime.setRegionSize,
    collapse(regionId) { runtime.setRegionCollapsed(regionId, true); },
    expand(regionId) { runtime.setRegionCollapsed(regionId, false); },
    reset: runtime.resetLayout,
  };
}

import {
  canonicalizeWorkspacePack,
  parseWorkspacePack,
  validateWorkspacePackCompatibility,
  type InstalledWorkspacePack,
  type WorkspaceComponentCatalogContract,
  type WorkspacePackDocument,
  type WorkspacePackOverride,
  type WorkspacePackRef,
  type WorkspacePackValidationResult,
  type WorkspaceUserPreferences,
} from '../../../../../packages/workspace-packs/src/runtime';

const STORE_KEY = 'sayre.workspace-packs.v1';
const ACTIVE_KEY = 'sayre.workspace-packs.active.v1';
const STATE_KEY = 'sayre.workspace-packs.state.v1';
const PREFERENCES_KEY = 'sayre.workspace-packs.preferences.v1';
const OVERRIDES_KEY = 'sayre.workspace-packs.personal-overrides.v1';

function key(ref: WorkspacePackRef): string { return `${ref.id}@${ref.version}`; }
function refFor(pack: WorkspacePackDocument): WorkspacePackRef { return { id: pack.metadata.id, version: pack.metadata.version }; }
function violation(code: string, path: string, message: string): WorkspacePackValidationResult {
  return { ok: false, violations: [{ code, path, message }] };
}

function readRecord(
  storage: Storage | null,
  storageKey: string,
  report?: (message: string) => void,
): Record<string, unknown> {
  if (storage === null) {
    report?.('Browser storage is unavailable. Built-in Workspace Packs remain available for this session.');
    return {};
  }
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    report?.(`Stored Workspace Pack data at ${storageKey} is invalid and was ignored.`);
    return {};
  } catch {
    report?.(`Stored Workspace Pack data at ${storageKey} is corrupt or inaccessible and was ignored.`);
    return {};
  }
}

function persist(storage: Storage | null, storageKey: string, value: unknown): void {
  if (storage === null) throw new Error('Browser storage is unavailable.');
  storage.setItem(storageKey, JSON.stringify(value));
}

function preferenceValue(value: unknown, ref: WorkspacePackRef, layoutId: string): WorkspaceUserPreferences | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((field) => !['pack', 'layoutId', 'regionSizes', 'collapsedRegionIds', 'updatedAt'].includes(field))) return null;
  if (raw.layoutId !== layoutId || typeof raw.updatedAt !== 'string') return null;
  if (raw.pack === null || typeof raw.pack !== 'object' || Array.isArray(raw.pack)) return null;
  const pack = raw.pack as Record<string, unknown>;
  if (pack.id !== ref.id || pack.version !== ref.version || Object.keys(pack).some((field) => !['id', 'version'].includes(field))) return null;
  if (raw.regionSizes === null || typeof raw.regionSizes !== 'object' || Array.isArray(raw.regionSizes)) return null;
  const regionSizes = raw.regionSizes as Record<string, unknown>;
  if (Object.entries(regionSizes).some(([id, size]) => !/^[a-z0-9][a-z0-9.-]{2,95}$/.test(id) || typeof size !== 'number' || !Number.isFinite(size))) return null;
  if (!Array.isArray(raw.collapsedRegionIds) || raw.collapsedRegionIds.some((id) => typeof id !== 'string')) return null;
  return structuredClone(value) as WorkspaceUserPreferences;
}

function validatedOverride(
  base: WorkspacePackDocument,
  value: unknown,
  catalog: WorkspaceComponentCatalogContract,
  validateComponentProps?: (pack: WorkspacePackDocument) => WorkspacePackValidationResult,
): WorkspacePackOverride | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((field) => !['theme', 'defaultLayoutId', 'defaultViewId', 'layouts', 'views'].includes(field))) return null;
  const override = structuredClone(raw) as WorkspacePackOverride;
  const candidate: WorkspacePackDocument = {
    ...structuredClone(base),
    defaultLayoutId: override.defaultLayoutId ?? base.defaultLayoutId,
    defaultViewId: override.defaultViewId ?? base.defaultViewId,
    layouts: override.layouts ?? base.layouts,
    views: override.views ?? base.views,
    theme: override.theme === undefined ? base.theme : {
      ...base.theme,
      ...override.theme,
      colors: { ...base.theme.colors, ...(override.theme.colors ?? {}) },
      typography: { ...base.theme.typography, ...(override.theme.typography ?? {}) },
    },
  };
  const compatible = validateWorkspacePackCompatibility(candidate, catalog);
  if (!compatible.ok) return null;
  const props = validateComponentProps?.(compatible.pack);
  return props !== undefined && !props.ok ? null : override;
}

export interface WorkspacePackStore {
  list(): readonly InstalledWorkspacePack[];
  get(ref: WorkspacePackRef): InstalledWorkspacePack | null;
  install(rawJson: string): WorkspacePackValidationResult;
  fork(source: WorkspacePackRef, identity: { id: string; name: string; version: string; author: string }, materialized?: WorkspacePackDocument): InstalledWorkspacePack;
  forkAndActivate(source: WorkspacePackRef, identity: { id: string; name: string; version: string; author: string }, materialized: WorkspacePackDocument): InstalledWorkspacePack;
  uninstall(ref: WorkspacePackRef): void;
  active(): WorkspacePackRef;
  activate(ref: WorkspacePackRef): void;
  preferences(ref: WorkspacePackRef, layoutId: string): WorkspaceUserPreferences | null;
  savePreferences(preferences: WorkspaceUserPreferences): void;
  resetPreferences(ref: WorkspacePackRef, layoutId?: string): void;
  personalOverride(ref: WorkspacePackRef): WorkspacePackOverride | null;
  personalOverrideRevision(ref: WorkspacePackRef): number;
  savePersonalOverride(ref: WorkspacePackRef, override: WorkspacePackOverride, expectedRevision?: number): void;
  resetPersonalOverride(ref: WorkspacePackRef, expectedRevision?: number): void;
  export(ref: WorkspacePackRef): string;
  recoveryMessage(): string | null;
  refresh(): void;
  subscribe(listener: () => void): () => void;
}

export function createBrowserWorkspacePackStore(input: {
  builtins: readonly InstalledWorkspacePack[];
  storage: Storage | null;
  catalog: WorkspaceComponentCatalogContract;
  now?: () => Date;
  validateComponentProps?: (pack: WorkspacePackDocument) => WorkspacePackValidationResult;
}): WorkspacePackStore {
  const now = input.now ?? (() => new Date());
  const builtins = new Map(input.builtins.map((item) => [key(item.ref), structuredClone(item)]));
  const imported = new Map<string, InstalledWorkspacePack>();
  const listeners = new Set<() => void>();
  let storageIssue: string | null = input.storage === null
    ? 'Browser storage is unavailable. Built-in Workspace Packs remain available for this session.'
    : null;
  const reportStorageIssue = (message: string): void => { storageIssue = message; };
  const notify = (): void => listeners.forEach((listener) => listener());
  const defaultRef = input.builtins[0]?.ref;
  if (defaultRef === undefined) throw new Error('At least one built-in pack is required.');

  interface PersistedPackState {
    installed: Record<string, unknown>;
    active: WorkspacePackRef;
    revision: number;
  }

  const legacyActive = (): WorkspacePackRef => {
    if (input.storage === null) return defaultRef;
    try {
      const raw = input.storage.getItem(ACTIVE_KEY);
      if (raw === null) return defaultRef;
      const candidate = JSON.parse(raw) as WorkspacePackRef;
      return candidate !== null && typeof candidate === 'object'
        && typeof candidate.id === 'string' && typeof candidate.version === 'string'
        ? candidate : defaultRef;
    } catch {
      reportStorageIssue('The stored active Workspace Pack reference is corrupt or inaccessible. The default pack was restored.');
      return defaultRef;
    }
  };

  const readPackState = (): PersistedPackState => {
    const raw = readRecord(input.storage, STATE_KEY, reportStorageIssue);
    if (Object.keys(raw).length === 0) {
      return { installed: readRecord(input.storage, STORE_KEY, reportStorageIssue), active: legacyActive(), revision: 0 };
    }
    const installed = raw.installed;
    const active = raw.active;
    const revision = raw.revision;
    if (installed === null || typeof installed !== 'object' || Array.isArray(installed)
      || active === null || typeof active !== 'object' || Array.isArray(active)
      || typeof (active as Record<string, unknown>).id !== 'string'
      || typeof (active as Record<string, unknown>).version !== 'string'
      || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      reportStorageIssue('The stored Workspace Pack transaction is invalid. The default pack was restored.');
      return { installed: {}, active: defaultRef, revision: 0 };
    }
    return {
      installed: installed as Record<string, unknown>,
      active: active as unknown as WorkspacePackRef,
      revision,
    };
  };

  let persistedRevision = 0;
  let activeRef = structuredClone(defaultRef);

  const hydrateImported = (): void => {
    const persisted = readPackState();
    const next = new Map<string, InstalledWorkspacePack>();
    for (const [entryKey, raw] of Object.entries(persisted.installed)) {
      if (typeof raw !== 'string') continue;
      try {
        const parsed = parseWorkspacePack(JSON.parse(raw));
        if (!parsed.ok) continue;
        const compatible = validateWorkspacePackCompatibility(parsed.pack, input.catalog);
        if (!compatible.ok || (input.validateComponentProps && !input.validateComponentProps(compatible.pack).ok) || key(refFor(compatible.pack)) !== entryKey || builtins.has(entryKey)) continue;
        next.set(entryKey, { ref: refFor(compatible.pack), source: 'imported', installedAt: now().toISOString(), pack: compatible.pack });
      } catch {
        reportStorageIssue(`Stored Workspace Pack ${entryKey} is corrupt and was ignored.`);
      }
    }
    imported.clear();
    for (const [entryKey, item] of next) imported.set(entryKey, item);
    persistedRevision = persisted.revision;
    activeRef = builtins.has(key(persisted.active)) || imported.has(key(persisted.active))
      ? structuredClone(persisted.active)
      : structuredClone(defaultRef);
    if (key(activeRef) !== key(persisted.active)) {
      reportStorageIssue(`Workspace Pack ${key(persisted.active)} is unavailable or incompatible. The default pack was restored.`);
    }
  };
  hydrateImported();

  const persistPackState = (
    nextImported: ReadonlyMap<string, InstalledWorkspacePack>,
    nextActive: WorkspacePackRef,
  ): void => {
    const nextRevision = persistedRevision + 1;
    persist(input.storage, STATE_KEY, {
      installed: Object.fromEntries([...nextImported].map(([entryKey, item]) => [entryKey, canonicalizeWorkspacePack(item.pack)])),
      active: nextActive,
      revision: nextRevision,
    });
    persistedRevision = nextRevision;
  };

  const overrideEntry = (ref: WorkspacePackRef): { override: WorkspacePackOverride | null; revision: number } => {
    const value = readRecord(input.storage, OVERRIDES_KEY, reportStorageIssue)[key(ref)];
    const base = builtins.get(key(ref)) ?? imported.get(key(ref));
    if (base === undefined) return { override: null, revision: 0 };
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && 'override' in value && 'revision' in value) {
      const envelope = value as Record<string, unknown>;
      const revision = typeof envelope.revision === 'number' && Number.isSafeInteger(envelope.revision) && envelope.revision >= 0
        ? envelope.revision : 0;
      const override = validatedOverride(base.pack, envelope.override, input.catalog, input.validateComponentProps);
      if (override === null && envelope.override !== null) reportStorageIssue(`The personal override for ${key(ref)} is incompatible and was ignored.`);
      return { override, revision };
    }
    const override = validatedOverride(base.pack, value, input.catalog, input.validateComponentProps);
    return { override, revision: override === null ? 0 : 1 };
  };

  const prepareFork = (
    source: WorkspacePackRef,
    identity: { id: string; name: string; version: string; author: string },
    materialized?: WorkspacePackDocument,
  ): InstalledWorkspacePack => {
    const base = builtins.get(key(source)) ?? imported.get(key(source));
    if (!base) throw new Error('Source pack is unavailable.');
    const personal = materialized === undefined ? overrideEntry(source).override : null;
    const pack: WorkspacePackDocument = {
      ...structuredClone(materialized ?? base.pack),
      ...(personal ?? {}),
      theme: personal?.theme ? {
        ...(materialized ?? base.pack).theme,
        ...personal.theme,
        colors: { ...(materialized ?? base.pack).theme.colors, ...(personal.theme.colors ?? {}) },
        typography: { ...(materialized ?? base.pack).theme.typography, ...(personal.theme.typography ?? {}) },
      } : structuredClone((materialized ?? base.pack).theme),
      metadata: { ...base.pack.metadata, ...identity, derivedFrom: source },
    };
    const compatible = validateWorkspacePackCompatibility(pack, input.catalog);
    if (!compatible.ok) throw new Error(compatible.violations.map((item) => item.message).join('; '));
    const props = input.validateComponentProps?.(compatible.pack);
    if (props !== undefined && !props.ok) throw new Error(props.violations.map((item) => item.message).join('; '));
    const ref = refFor(compatible.pack);
    if (builtins.has(key(ref)) || imported.has(key(ref))) throw new Error('Fork destination already exists.');
    return { ref, source: 'forked', installedAt: now().toISOString(), pack: compatible.pack };
  };

  const commitFork = (item: InstalledWorkspacePack, activate: boolean): InstalledWorkspacePack => {
    const nextImported = new Map(imported);
    nextImported.set(key(item.ref), item);
    const nextActive = activate ? item.ref : activeRef;
    persistPackState(nextImported, nextActive);
    imported.clear();
    for (const [itemKey, installed] of nextImported) imported.set(itemKey, installed);
    activeRef = structuredClone(nextActive);
    notify();
    return structuredClone(item);
  };

  return {
    list: () => [...builtins.values(), ...imported.values()].map((item) => structuredClone(item)),
    get: (ref) => structuredClone(builtins.get(key(ref)) ?? imported.get(key(ref)) ?? null),
    install(rawJson) {
      let value: unknown;
      try { value = JSON.parse(rawJson); } catch { return violation('invalid-json', '', 'Import is not valid JSON.'); }
      const parsed = parseWorkspacePack(value); if (!parsed.ok) return parsed;
      const compatible = validateWorkspacePackCompatibility(parsed.pack, input.catalog); if (!compatible.ok) return compatible;
      const props = input.validateComponentProps?.(compatible.pack); if (props !== undefined && !props.ok) return props;
      const ref = refFor(compatible.pack); const entryKey = key(ref);
      if (builtins.has(entryKey)) return violation('builtin-conflict', '/metadata', 'Built-in packs cannot be shadowed.');
      const existing = imported.get(entryKey);
      if (existing !== undefined) return canonicalizeWorkspacePack(existing.pack) === canonicalizeWorkspacePack(compatible.pack)
        ? compatible : violation('version-conflict', '/metadata/version', 'The same ID/version has different content.');
      const nextImported = new Map(imported);
      nextImported.set(entryKey, { ref, source: 'imported', installedAt: now().toISOString(), pack: compatible.pack });
      try { persistPackState(nextImported, activeRef); } catch { return violation('storage-failed', '', 'The pack is valid but could not be persisted.'); }
      imported.clear(); for (const [itemKey, item] of nextImported) imported.set(itemKey, item);
      notify(); return compatible;
    },
    fork(source, identity, materialized) {
      return commitFork(prepareFork(source, identity, materialized), false);
    },
    forkAndActivate(source, identity, materialized) {
      return commitFork(prepareFork(source, identity, materialized), true);
    },
    uninstall(ref) {
      if (builtins.has(key(ref))) throw new Error('Built-in packs cannot be uninstalled.');
      if (!imported.has(key(ref))) return;
      const wasActive = key(activeRef) === key(ref);
      const nextImported = new Map(imported); nextImported.delete(key(ref));
      const nextActive = wasActive ? defaultRef : activeRef;
      persistPackState(nextImported, nextActive);
      imported.clear(); for (const [itemKey, item] of nextImported) imported.set(itemKey, item);
      activeRef = structuredClone(nextActive);
      if (wasActive) {
        storageIssue = `Removed active Workspace Pack ${key(ref)}. The default pack is now active.`;
      }
      notify();
    },
    active: () => structuredClone(activeRef),
    activate(ref) {
      if (!builtins.has(key(ref)) && !imported.has(key(ref))) throw new Error('Pack is not installed.');
      persistPackState(imported, ref); activeRef = structuredClone(ref); notify();
    },
    preferences(ref, layoutId) {
      const value = readRecord(input.storage, PREFERENCES_KEY, reportStorageIssue)[`${key(ref)}:${layoutId}`];
      const validated = preferenceValue(value, ref, layoutId);
      if (value !== undefined && validated === null) {
        reportStorageIssue(`Stored layout preferences for ${key(ref)} and ${layoutId} are invalid and were reset.`);
      }
      return validated;
    },
    savePreferences(preferences) {
      if (preferenceValue(preferences, preferences.pack, preferences.layoutId) === null) throw new Error('Workspace preferences are invalid.');
      const record = readRecord(input.storage, PREFERENCES_KEY, reportStorageIssue);
      record[`${key(preferences.pack)}:${preferences.layoutId}`] = preferences as unknown as Record<string, unknown>;
      persist(input.storage, PREFERENCES_KEY, record); notify();
    },
    resetPreferences(ref, layoutId) {
      const record = readRecord(input.storage, PREFERENCES_KEY, reportStorageIssue);
      for (const entryKey of Object.keys(record)) if (entryKey.startsWith(`${key(ref)}:`) && (layoutId === undefined || entryKey === `${key(ref)}:${layoutId}`)) delete record[entryKey];
      persist(input.storage, PREFERENCES_KEY, record); notify();
    },
    personalOverride(ref) {
      return overrideEntry(ref).override;
    },
    personalOverrideRevision(ref) {
      return overrideEntry(ref).revision;
    },
    savePersonalOverride(ref, override, expectedRevision) {
      const base = builtins.get(key(ref)) ?? imported.get(key(ref));
      if (base === undefined) throw new Error('Base pack is unavailable.');
      const validated = validatedOverride(base.pack, override, input.catalog, input.validateComponentProps);
      if (validated === null) throw new Error('Personal override is incompatible with its exact base version.');
      const current = overrideEntry(ref);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new Error(`Personal override conflict: expected revision ${expectedRevision}, found ${current.revision}. Discard/reload or materialize a fork.`);
      }
      const record = readRecord(input.storage, OVERRIDES_KEY, reportStorageIssue);
      record[key(ref)] = { revision: current.revision + 1, override: structuredClone(validated) };
      persist(input.storage, OVERRIDES_KEY, record); notify();
    },
    resetPersonalOverride(ref, expectedRevision) {
      const current = overrideEntry(ref);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new Error(`Personal override conflict: expected revision ${expectedRevision}, found ${current.revision}.`);
      }
      const record = readRecord(input.storage, OVERRIDES_KEY, reportStorageIssue); delete record[key(ref)];
      persist(input.storage, OVERRIDES_KEY, record); notify();
    },
    export(ref) {
      const item = builtins.get(key(ref)) ?? imported.get(key(ref));
      if (!item) throw new Error('Pack is unavailable.');
      return canonicalizeWorkspacePack(item.pack);
    },
    recoveryMessage() {
      const message = storageIssue;
      storageIssue = null;
      return message;
    },
    refresh() {
      hydrateImported();
      notify();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

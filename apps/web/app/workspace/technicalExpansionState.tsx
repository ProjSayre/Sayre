'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  defaultTechnicalExpansionPreferences,
  parseTechnicalExpansionPreferences,
  pruneTechnicalExpansionPreferences,
  serializeTechnicalExpansionPreferences,
  type TechnicalExpansionMode,
  type TechnicalExpansionPreferences,
  type TechnicalTransientReveal,
} from './technicalExpansion';
import type { GraphNode } from './types';

interface ScopedPreferences {
  scopeKey: string | null;
  value: TechnicalExpansionPreferences;
}

interface ScopedTransientReveal {
  scopeKey: string | null;
  value: TechnicalTransientReveal | null;
}

interface TechnicalExpansionContextValue {
  preferences: TechnicalExpansionPreferences;
  transientReveal: TechnicalTransientReveal | null;
  setMode: (mode: TechnicalExpansionMode) => void;
  setFolderExpanded: (nodeId: string, expanded: boolean) => void;
  collapseAllFolders: () => void;
  togglePinned: (nodeId: string) => void;
  revealTransient: (
    source: TechnicalTransientReveal['source'],
    nodeIds: Iterable<string>,
  ) => void;
  clearTransientReveal: (
    source?: TechnicalTransientReveal['source'],
  ) => void;
  reset: () => void;
}

const TechnicalExpansionContext =
  createContext<TechnicalExpansionContextValue | null>(null);

function storageKey(scopeKey: string): string {
  return `sayre:technical-expansion:${scopeKey}`;
}

function readSession(scopeKey: string): TechnicalExpansionPreferences {
  try {
    return parseTechnicalExpansionPreferences(
      window.sessionStorage.getItem(storageKey(scopeKey)),
    );
  } catch {
    return defaultTechnicalExpansionPreferences();
  }
}

function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every((value) => right.has(value))
  );
}

function preferencesEqual(
  left: TechnicalExpansionPreferences,
  right: TechnicalExpansionPreferences,
): boolean {
  return (
    left.mode === right.mode &&
    setsEqual(left.manuallyExpanded, right.manuallyExpanded) &&
    setsEqual(left.manuallyCollapsed, right.manuallyCollapsed) &&
    setsEqual(left.pinnedBranches, right.pinnedBranches) &&
    left.manualOrder.length === right.manualOrder.length &&
    left.manualOrder.every((value, index) => value === right.manualOrder[index])
  );
}

interface TechnicalExpansionProviderProps {
  children: ReactNode;
  scopeKey: string;
  /**
   * `null` while a different workspace view is active. That prevents Product
   * or Onboarding projections from pruning Technical Tree intent.
   */
  nodes: readonly GraphNode[] | null;
}

export function TechnicalExpansionProvider({
  children,
  scopeKey,
  nodes,
}: TechnicalExpansionProviderProps) {
  const [scoped, setScoped] = useState<ScopedPreferences>({
    scopeKey: null,
    value: defaultTechnicalExpansionPreferences(),
  });
  const [scopedTransient, setScopedTransient] =
    useState<ScopedTransientReveal>({
      scopeKey: null,
      value: null,
    });
  const latestNodes = useRef(nodes);
  const latestScopeKey = useRef(scopeKey);
  latestNodes.current = nodes;
  latestScopeKey.current = scopeKey;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const deepLinkNodeId = new URLSearchParams(window.location.search)
      .get('nodeId')
      ?.trim();
    setScoped({
      scopeKey,
      value: readSession(scopeKey),
    });
    setScopedTransient({
      scopeKey,
      value: deepLinkNodeId
        ? {
            source: 'deep-link',
            nodeIds: new Set([deepLinkNodeId]),
          }
        : null,
    });
  }, [scopeKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (scoped.scopeKey !== scopeKey) return;
    try {
      window.sessionStorage.setItem(
        storageKey(scopeKey),
        serializeTechnicalExpansionPreferences(scoped.value),
      );
    } catch {
      // A disabled or full session store must not make the graph unusable.
    }
  }, [scopeKey, scoped]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (nodes === null || scoped.scopeKey !== scopeKey) return;
    const expectedNodes = nodes;
    const timer = window.setTimeout(() => {
      if (
        latestScopeKey.current !== scopeKey ||
        latestNodes.current !== expectedNodes
      ) {
        return;
      }
      setScoped((current) => {
        if (current.scopeKey !== scopeKey) return current;
        const next = pruneTechnicalExpansionPreferences(
          current.value,
          expectedNodes,
        );
        return preferencesEqual(current.value, next)
          ? current
          : { ...current, value: next };
      });
      setScopedTransient((current) => {
        if (current.scopeKey !== scopeKey || current.value === null) {
          return current;
        }
        const authorizedNodeIds = new Set(expectedNodes.map((node) => node.id));
        const nodeIds = new Set(
          [...current.value.nodeIds].filter((id) =>
            authorizedNodeIds.has(id),
          ),
        );
        return nodeIds.size === current.value.nodeIds.size
          ? current
          : {
              ...current,
              value:
                nodeIds.size === 0
                  ? null
                  : { ...current.value, nodeIds },
            };
      });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [nodes, scopeKey, scoped.scopeKey]);

  const update = useCallback(
    (
      transform: (
        current: TechnicalExpansionPreferences,
      ) => TechnicalExpansionPreferences,
    ): void => {
      setScoped((current) => {
        const value =
          current.scopeKey === scopeKey
            ? current.value
            : defaultTechnicalExpansionPreferences();
        return { scopeKey, value: transform(value) };
      });
    },
    [scopeKey],
  );

  const setMode = useCallback(
    (mode: TechnicalExpansionMode): void => {
      update((current) =>
        current.mode === mode ? current : { ...current, mode },
      );
    },
    [update],
  );

  const setFolderExpanded = useCallback(
    (nodeId: string, expanded: boolean): void => {
      update((current) => {
        const manuallyExpanded = new Set(current.manuallyExpanded);
        const manuallyCollapsed = new Set(current.manuallyCollapsed);
        const pinnedBranches = new Set(current.pinnedBranches);

        if (expanded) {
          manuallyExpanded.add(nodeId);
          manuallyCollapsed.delete(nodeId);
        } else {
          manuallyExpanded.delete(nodeId);
          manuallyCollapsed.add(nodeId);
          pinnedBranches.delete(nodeId);
        }

        return {
          ...current,
          mode:
            !expanded && current.mode === 'full'
              ? 'balanced'
              : current.mode,
          manuallyExpanded,
          manuallyCollapsed,
          pinnedBranches,
          manualOrder: expanded
            ? [
                nodeId,
                ...current.manualOrder.filter((id) => id !== nodeId),
              ]
            : current.manualOrder.filter((id) => id !== nodeId),
        };
      });
    },
    [update],
  );

  const collapseAllFolders = useCallback((): void => {
    const currentNodes = latestNodes.current ?? [];
    const parentIds = new Set(
      currentNodes
        .map((node) => node.parentId)
        .filter((id): id is string => id !== null),
    );
    const folderIds = new Set(
      currentNodes
        .filter(
          (node) => node.kind === 'Folder' && parentIds.has(node.id),
        )
        .map((node) => node.id),
    );
    if (folderIds.size === 0) return;

    update((current) => ({
      ...current,
      mode: current.mode === 'full' ? 'balanced' : current.mode,
      manuallyExpanded: new Set(
        [...current.manuallyExpanded].filter((id) => !folderIds.has(id)),
      ),
      manuallyCollapsed: new Set([
        ...current.manuallyCollapsed,
        ...folderIds,
      ]),
      pinnedBranches: new Set(
        [...current.pinnedBranches].filter((id) => !folderIds.has(id)),
      ),
      manualOrder: current.manualOrder.filter((id) => !folderIds.has(id)),
    }));
  }, [update]);

  const togglePinned = useCallback(
    (nodeId: string): void => {
      update((current) => {
        const pinnedBranches = new Set(current.pinnedBranches);
        const manuallyExpanded = new Set(current.manuallyExpanded);
        const manuallyCollapsed = new Set(current.manuallyCollapsed);
        const pinned = !pinnedBranches.has(nodeId);

        if (pinned) {
          pinnedBranches.add(nodeId);
          manuallyExpanded.add(nodeId);
          manuallyCollapsed.delete(nodeId);
        } else {
          pinnedBranches.delete(nodeId);
        }

        return {
          ...current,
          pinnedBranches,
          manuallyExpanded,
          manuallyCollapsed,
          manualOrder: pinned
            ? [
                nodeId,
                ...current.manualOrder.filter((id) => id !== nodeId),
              ]
            : current.manualOrder,
        };
      });
    },
    [update],
  );

  const revealTransient = useCallback(
    (
      source: TechnicalTransientReveal['source'],
      nodeIds: Iterable<string>,
    ): void => {
      const normalized = new Set(
        [...nodeIds].filter((id) => id.trim().length > 0),
      );
      setScopedTransient({
        scopeKey,
        value:
          normalized.size === 0 ? null : { source, nodeIds: normalized },
      });
    },
    [scopeKey],
  );

  const clearTransientReveal = useCallback(
    (source?: TechnicalTransientReveal['source']): void => {
      setScopedTransient((current) => {
        if (
          current.scopeKey !== scopeKey ||
          current.value === null ||
          (source !== undefined && current.value.source !== source)
        ) {
          return current;
        }
        return { scopeKey, value: null };
      });
    },
    [scopeKey],
  );

  const reset = useCallback((): void => {
    update(() => defaultTechnicalExpansionPreferences());
    setScopedTransient({ scopeKey, value: null });
  }, [scopeKey, update]);

  const preferences =
    scoped.scopeKey === scopeKey
      ? scoped.value
      : defaultTechnicalExpansionPreferences();
  const transientReveal =
    scopedTransient.scopeKey === scopeKey ? scopedTransient.value : null;
  const value = useMemo<TechnicalExpansionContextValue>(
    () => ({
      preferences,
      transientReveal,
      setMode,
      setFolderExpanded,
      collapseAllFolders,
      togglePinned,
      revealTransient,
      clearTransientReveal,
      reset,
    }),
    [
      clearTransientReveal,
      collapseAllFolders,
      preferences,
      reset,
      revealTransient,
      setFolderExpanded,
      setMode,
      togglePinned,
      transientReveal,
    ],
  );

  return (
    <TechnicalExpansionContext.Provider value={value}>
      {children}
    </TechnicalExpansionContext.Provider>
  );
}

export function useTechnicalExpansion(): TechnicalExpansionContextValue {
  const value = useContext(TechnicalExpansionContext);
  if (value === null) {
    throw new Error(
      'useTechnicalExpansion must be used inside <TechnicalExpansionProvider>.',
    );
  }
  return value;
}

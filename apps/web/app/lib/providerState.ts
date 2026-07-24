'use client';

import { useEffect, useState } from 'react';
import type {
  ProviderJobReason,
  ProviderJobState,
  ProviderJobStatus,
  ProviderJobSurface,
} from '@sayre/shared-types';

const STATUSES = new Set<ProviderJobStatus>(['generating', 'ready', 'degraded', 'failed']);
const SURFACES = new Set<ProviderJobSurface>(['product', 'onboarding', 'chatbot']);
const REASONS = new Set<ProviderJobReason>([
  'timeout',
  'circuit_open',
  'provider_error',
  'retry_exhausted',
  'processing_error',
]);
const RESPONSE_KEYS = new Set([
  'repositoryId',
  'refName',
  'revisionSha',
  'surface',
  'status',
  'reasonCode',
  'updatedAt',
]);
const REFRESH_MS = 5_000;

export interface ProviderStateSelection {
  repositoryId: string;
  refName: string;
  surface: ProviderJobSurface;
}

export interface ProviderStateSnapshot {
  state: ProviderJobState | null;
  loading: boolean;
}

function isProviderJobState(
  value: unknown,
  selection: ProviderStateSelection,
): value is ProviderJobState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => !RESPONSE_KEYS.has(key)) ||
    candidate.repositoryId !== selection.repositoryId ||
    candidate.refName !== selection.refName ||
    candidate.surface !== selection.surface ||
    typeof candidate.revisionSha !== 'string' ||
    typeof candidate.status !== 'string' ||
    !STATUSES.has(candidate.status as ProviderJobStatus) ||
    typeof candidate.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.updatedAt))
  ) {
    return false;
  }
  if (
    candidate.reasonCode !== null &&
    (typeof candidate.reasonCode !== 'string' ||
      !REASONS.has(candidate.reasonCode as ProviderJobReason))
  ) {
    return false;
  }
  return !(
    ((candidate.status === 'generating' || candidate.status === 'ready') &&
      candidate.reasonCode !== null) ||
    ((candidate.status === 'degraded' || candidate.status === 'failed') &&
      candidate.reasonCode === null)
  );
}

export async function fetchProviderState(
  selection: ProviderStateSelection,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ProviderJobState | null> {
  if (!SURFACES.has(selection.surface)) return null;
  const query = new URLSearchParams({
    refName: selection.refName,
    surface: selection.surface,
  });
  const response = await fetcher(
    `/api/provider-state/${encodeURIComponent(selection.repositoryId)}?${query.toString()}`,
    {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    },
  );
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (payload === null) return null;
  return isProviderJobState(payload, selection) ? payload : null;
}

export function useProviderState(
  selection: ProviderStateSelection | null,
): ProviderStateSnapshot {
  const repositoryId = selection?.repositoryId;
  const refName = selection?.refName;
  const surface = selection?.surface;
  const [snapshot, setSnapshot] = useState<ProviderStateSnapshot>({
    state: null,
    loading: selection !== null,
  });

  useEffect(() => {
    if (repositoryId === undefined || refName === undefined || surface === undefined) {
      setSnapshot({ state: null, loading: false });
      return;
    }
    const currentSelection: ProviderStateSelection = {
      repositoryId,
      refName,
      surface,
    };

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const refresh = async (initial: boolean): Promise<void> => {
      controller = new AbortController();
      if (initial) setSnapshot({ state: null, loading: true });
      try {
        const state = await fetchProviderState(currentSelection, controller.signal);
        if (active) setSnapshot({ state, loading: false });
      } catch {
        // Authentication, transport, malformed JSON, and abort failures all fail
        // closed. Structural canvas content remains usable, and no provider detail
        // is reflected.
        if (active) setSnapshot({ state: null, loading: false });
      } finally {
        if (active) {
          timer = setTimeout(() => {
            void refresh(false);
          }, REFRESH_MS);
        }
      }
    };

    void refresh(true);
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [repositoryId, refName, surface]);

  return snapshot;
}

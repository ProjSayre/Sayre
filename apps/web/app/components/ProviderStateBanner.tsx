'use client';

import React from 'react';
import type { ProviderJobState } from '@sayre/shared-types';
import {
  useProviderState,
  type ProviderStateSelection,
} from '../lib/providerState';

export function ProviderStateBanner({
  state,
  loading = false,
}: {
  state: ProviderJobState | null;
  loading?: boolean;
}) {
  const status = loading ? 'generating' : state?.status;
  if (status === undefined || status === 'ready') return null;

  const copy =
    status === 'generating'
      ? 'Generating semantic view…'
      : status === 'degraded'
        ? 'Semantic view is temporarily degraded. Structural data is still available.'
        : 'Semantic view generation failed. Structural data is still available.';

  return (
    <div
      className={`provider-state-banner provider-state-${status}`}
      role="status"
      aria-live="polite"
    >
      <span className="provider-state-indicator" aria-hidden="true" />
      {copy}
    </div>
  );
}

export function ProviderStateStatus({
  selection,
}: {
  selection: ProviderStateSelection | null;
}) {
  const { state, loading } = useProviderState(selection);
  return <ProviderStateBanner state={state} loading={loading} />;
}

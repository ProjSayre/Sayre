'use client';

import { useMock } from '../state';
import type { SemanticStatus, ViewId } from '../types';
import { formatTimestamp } from './ui';

interface BannerCopy {
  headline: string;
  detail: string | null;
}

/**
 * Background processing is translated into user language here. Queues, workers,
 * circuit breakers, and retries never surface by name.
 */
function copyFor(status: SemanticStatus, view: ViewId): BannerCopy {
  switch (status) {
    case 'generating':
      return {
        headline: 'Generating Product Tree',
        detail:
          view === 'product'
            ? 'Feature boundaries are still being generated. This view will fill in as they land.'
            : 'Feature boundaries are still being generated. The Technical Tree is complete and unaffected.',
      };
    case 'ready':
      return { headline: 'Product Tree ready', detail: null };
    case 'degraded':
      return {
        headline: 'Semantic features temporarily degraded',
        detail:
          'Some descriptions and feature boundaries may be missing or out of date. Repository structure remains available.',
      };
    case 'failed':
      return {
        headline: 'Semantic features unavailable',
        detail:
          'Product Tree generation did not complete for this ref. Repository structure remains available.',
      };
  }
}

export function StatusBanner() {
  const { state, semanticState } = useMock();
  const { headline, detail } = copyFor(semanticState.status, state.view);

  return (
    <div
      className={`mock-banner mock-banner-${semanticState.status}`}
      role={semanticState.status === 'failed' ? 'alert' : 'status'}
    >
      <span className="mock-banner-dot" />
      <div className="mock-banner-body">
        <strong>{headline}</strong>
        {detail !== null && <p>{detail}</p>}
      </div>
      <span className="mock-banner-time">
        updated {formatTimestamp(semanticState.updatedAt)}
      </span>
    </div>
  );
}

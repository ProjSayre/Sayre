'use client';

import { useWorkspaceNavigation, useWorkspaceQueries } from '../state';
import type {
  ProductCoverage,
  SemanticStatus,
  ViewId,
} from '../types';
import { formatTimestamp } from './ui';

interface BannerCopy {
  headline: string;
  detail: string | null;
}

function readyCopy(
  view: ViewId,
  coverage: ProductCoverage | null,
  onboardingStepCount: number,
): BannerCopy {
  if (view === 'technical') {
    return {
      headline: 'Technical Tree ready',
      detail:
        'Start with Explorer or search. Open folder branches to narrow the graph, then select a file for dependencies and context.',
    };
  }
  if (view === 'onboarding') {
    return onboardingStepCount === 0
      ? {
          headline: 'No verified setup steps detected',
          detail:
            'This does not confirm the repository is ready. Review the setup landmarks and repository documentation before running it locally.',
        }
      : {
          headline: 'Suggested setup plan ready',
          detail:
            'Review and copy each command in order. Sandbox results are a constrained safety signal, not proof that the repository runs.',
        };
  }
  return {
    headline: 'Product Tree ready · AI-inferred',
    detail:
      coverage === null
        ? 'Only files assigned to an identified feature appear here. Unclassified files remain available in the Technical Tree.'
        : `${coverage.mappedFileCount.toLocaleString()} of ${coverage.totalFileCount.toLocaleString()} files mapped (${coverage.mappedPercent}%). ${coverage.unmappedFileCount.toLocaleString()} unmapped files are not shown in this partial product view.`,
  };
}

/**
 * Background processing is translated into user language here. Queues, workers,
 * circuit breakers, and retries never surface by name.
 */
function copyFor(
  status: SemanticStatus,
  view: ViewId,
  coverage: ProductCoverage | null,
  onboardingStepCount: number,
): BannerCopy {
  switch (status) {
    case 'generating':
      return {
        headline:
          view === 'onboarding'
            ? 'Generating suggested setup plan'
            : 'Generating Product Tree',
        detail:
          view === 'product'
            ? 'Feature boundaries are still being generated. This view will fill in as they land.'
            : view === 'onboarding'
              ? 'Repository structure is available now. Setup steps may still appear as analysis completes.'
              : 'Feature boundaries are still being generated. The Technical Tree is complete and unaffected.',
      };
    case 'ready':
      return readyCopy(view, coverage, onboardingStepCount);
    case 'degraded':
      return {
        headline:
          view === 'onboarding'
            ? 'Setup analysis is incomplete'
            : 'Semantic features temporarily degraded',
        detail:
          view === 'onboarding'
            ? 'Some setup steps may be missing or out of date. Verify commands against repository documentation.'
            : 'Some descriptions and feature boundaries may be missing or out of date. Repository structure remains available.',
      };
    case 'failed':
      return {
        headline:
          view === 'onboarding'
            ? 'Setup plan unavailable'
            : 'Semantic features unavailable',
        detail:
          view === 'onboarding'
            ? 'Sayre could not generate a setup plan for this ref. Use the repository landmarks and Technical Tree to continue.'
            : 'Product Tree generation did not complete for this ref. Repository structure remains available.',
      };
  }
}

export function StatusBanner() {
  const { graph, semanticState } = useWorkspaceQueries();
  const navigation = useWorkspaceNavigation();
  const { headline, detail } = copyFor(
    semanticState.status,
    navigation.viewId as ViewId,
    graph.productCoverage,
    graph.onboarding?.steps.length ?? 0,
  );
  const showTechnicalAction =
    navigation.viewId === 'product' &&
    semanticState.status === 'ready' &&
    (graph.productCoverage?.unmappedFileCount ?? 0) > 0;

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
      {showTechnicalAction && (
        <button
          type="button"
          className="mock-btn mock-btn-ghost mock-btn-sm"
          onClick={() => { navigation.selectView('technical'); navigation.setFileTreeOpen(true); }}
        >
          Open all files
        </button>
      )}
      {semanticState.updatedAt !== null && navigation.viewId !== 'technical' && (
        <span className="mock-banner-time">
          updated {formatTimestamp(semanticState.updatedAt)}
        </span>
      )}
    </div>
  );
}

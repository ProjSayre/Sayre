// CH-06 red suite — the pure citation-to-canvas-action resolver.
// Authored from .pipeline/spec.md before any implementation exists.

import { describe, expect, it } from 'vitest';
import type { ViewId } from '../types';
import type { ChatCitation, ChatCitationKind } from './chatContract';
import { citationTarget, type CitationTargetContext } from './citationTarget';

const KNOWN_FEATURES: ReadonlySet<string> = new Set(['feat_checkout']);

function citation(overrides: Partial<ChatCitation> & { kind: ChatCitationKind }): ChatCitation {
  return {
    nodeId: 'n_payment_form',
    label: 'PaymentForm.tsx',
    resolvedNodeId: null,
    ...overrides,
  };
}

function context(view: ViewId): CitationTargetContext {
  return { view, knownFeatureIds: KNOWN_FEATURES };
}

describe('citationTarget resolution table', () => {
  // @spec AC-5
  it('resolves file and folder citations to the resolved node id, falling back to the raw node id', () => {
    for (const view of ['technical', 'product', 'onboarding'] as const) {
      expect(citationTarget(citation({ kind: 'file', resolvedNodeId: 'n_resolved' }), context(view)))
        .toEqual({ kind: 'select-node', nodeId: 'n_resolved' });
      expect(citationTarget(citation({ kind: 'file', resolvedNodeId: null }), context(view)))
        .toEqual({ kind: 'select-node', nodeId: 'n_payment_form' });
      expect(citationTarget(citation({ kind: 'folder', nodeId: 'n_checkout', label: 'checkout/', resolvedNodeId: null }), context(view)))
        .toEqual({ kind: 'select-node', nodeId: 'n_checkout' });
      expect(citationTarget(citation({ kind: 'folder', nodeId: 'n_checkout', label: 'checkout/', resolvedNodeId: 'n_apps_web' }), context(view)))
        .toEqual({ kind: 'select-node', nodeId: 'n_apps_web' });
    }
  });

  // @spec AC-5
  it('selects the feature overlay for a known feature citation in the product view', () => {
    const known = citation({ kind: 'feature', nodeId: 'feat_checkout', label: 'Checkout & payments', resolvedNodeId: null });
    expect(citationTarget(known, context('product'))).toEqual({ kind: 'select-feature', featureId: 'feat_checkout' });
    expect(citationTarget({ ...known, resolvedNodeId: 'n_payment_form' }, context('product')))
      .toEqual({ kind: 'select-feature', featureId: 'feat_checkout' });
  });

  // @spec AC-5
  it('falls back to the resolved node for a feature or ticket outside the product-overlay case', () => {
    const known = citation({ kind: 'feature', nodeId: 'feat_checkout', label: 'Checkout & payments', resolvedNodeId: 'n_payment_form' });
    expect(citationTarget(known, context('technical'))).toEqual({ kind: 'select-node', nodeId: 'n_payment_form' });
    expect(citationTarget(known, context('onboarding'))).toEqual({ kind: 'select-node', nodeId: 'n_payment_form' });

    const unknownFeature = citation({ kind: 'feature', nodeId: 'feat_unmapped', label: 'Unmapped', resolvedNodeId: 'n_use_cart' });
    expect(citationTarget(unknownFeature, context('product'))).toEqual({ kind: 'select-node', nodeId: 'n_use_cart' });

    const ticket = citation({ kind: 'ticket', nodeId: 'tick_atlas_42', label: 'ATLAS-42', resolvedNodeId: 'n_checkout_page' });
    for (const view of ['technical', 'product', 'onboarding'] as const) {
      expect(citationTarget(ticket, context(view))).toEqual({ kind: 'select-node', nodeId: 'n_checkout_page' });
    }
  });

  // @spec EC-12
  it('resolves an unresolved feature or ticket citation to no canvas action', () => {
    const unresolvedFeature = citation({ kind: 'feature', nodeId: 'feat_unmapped', label: 'Unmapped', resolvedNodeId: null });
    const unresolvedTicket = citation({ kind: 'ticket', nodeId: 'tick_atlas_42', label: 'ATLAS-42', resolvedNodeId: null });
    for (const view of ['technical', 'product', 'onboarding'] as const) {
      expect(citationTarget(unresolvedFeature, context(view))).toEqual({ kind: 'none' });
      expect(citationTarget(unresolvedTicket, context(view))).toEqual({ kind: 'none' });
    }
    // A known feature id is only an overlay in the product view; elsewhere it needs a resolved node.
    const knownButUnresolved = citation({ kind: 'feature', nodeId: 'feat_checkout', label: 'Checkout & payments', resolvedNodeId: null });
    expect(citationTarget(knownButUnresolved, context('technical'))).toEqual({ kind: 'none' });
    expect(citationTarget(knownButUnresolved, context('onboarding'))).toEqual({ kind: 'none' });
  });

  // @spec AC-6 EC-13
  it('can never resolve an undrawable citation kind to a canvas selection', () => {
    for (const view of ['technical', 'product', 'onboarding'] as const) {
      expect(citationTarget(citation({ kind: 'unknown', nodeId: 'fn_calculate_total', label: 'calculateTotal()', resolvedNodeId: null }), context(view)))
        .toEqual({ kind: 'none' });
      // Even a fully resolved id cannot rescue a kind the canvas does not draw:
      // a Function or Class node must never become a canvas selection.
      expect(citationTarget(citation({ kind: 'unknown', nodeId: 'fn_calculate_total', label: 'calculateTotal()', resolvedNodeId: 'n_use_cart' }), context(view)))
        .toEqual({ kind: 'none' });
      expect(citationTarget(citation({ kind: 'unknown', nodeId: 'cls_cart', label: 'Cart', resolvedNodeId: 'n_use_cart' }), { view, knownFeatureIds: new Set(['cls_cart']) }))
        .toEqual({ kind: 'none' });
    }
  });
});

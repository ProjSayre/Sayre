/**
 * Pure citation-to-canvas-action resolver (AC-5, AC-6). No I/O, no React, no
 * traversal — a lookup against server-delivered fields only.
 */

import type { ChatCitation } from './chatContract';
import type { ViewId } from '../types';

export type CitationTarget =
  | { kind: 'select-node'; nodeId: string }
  | { kind: 'select-feature'; featureId: string }
  | { kind: 'none' };

export interface CitationTargetContext {
  view: ViewId;
  knownFeatureIds: ReadonlySet<string>;
}

/**
 * 'file' | 'folder'            -> select-node on resolvedNodeId ?? nodeId
 * 'feature', view 'product',
 *   id in knownFeatureIds      -> select-feature
 * 'feature' | 'ticket' with a
 *   non-null resolvedNodeId    -> select-node
 * anything else ('unknown',
 *   unresolved feature/ticket) -> none
 */
export function citationTarget(
  citation: ChatCitation,
  context: CitationTargetContext,
): CitationTarget {
  if (citation.kind === 'file' || citation.kind === 'folder') {
    return { kind: 'select-node', nodeId: citation.resolvedNodeId ?? citation.nodeId };
  }

  if (citation.kind === 'feature') {
    if (context.view === 'product' && context.knownFeatureIds.has(citation.nodeId)) {
      return { kind: 'select-feature', featureId: citation.nodeId };
    }
    return citation.resolvedNodeId !== null
      ? { kind: 'select-node', nodeId: citation.resolvedNodeId }
      : { kind: 'none' };
  }

  if (citation.kind === 'ticket') {
    return citation.resolvedNodeId !== null
      ? { kind: 'select-node', nodeId: citation.resolvedNodeId }
      : { kind: 'none' };
  }

  return { kind: 'none' };
}

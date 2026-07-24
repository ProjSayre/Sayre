import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type {
  RetrievalGraphNode,
  RetrievalGraphQueryService,
  RetrievalTraversal,
} from '../graph-query/types';

export const RETRIEVAL_ANCHOR_LIMIT = 8;
export const RETRIEVAL_MAX_HOPS = 2;
export const RETRIEVAL_NODE_LIMIT = 64;

const MAX_INPUT_CHARACTERS = 2_000;
const MAX_TERMS = 12;
const MAX_TERM_CHARACTERS = 64;

export class RetrievalContextInputError extends Error {}

function searchTerms(value: string, field: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_INPUT_CHARACTERS ||
    normalized.includes('\0')
  ) {
    throw new RetrievalContextInputError(
      `${field} must be non-blank, contain no NUL characters, and be at most ${MAX_INPUT_CHARACTERS} characters.`,
    );
  }

  const terms = normalized
    .split(/[^\p{L}\p{N}_.:/-]+/u)
    .map((term) => term.slice(0, MAX_TERM_CHARACTERS))
    .filter((term) => term.length > 0);
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

function exactNodeId(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_INPUT_CHARACTERS ||
    normalized.includes('\0')
  ) {
    throw new RetrievalContextInputError(
      `nodeId must be non-blank, contain no NUL characters, and be at most ${MAX_INPUT_CHARACTERS} characters.`,
    );
  }
  return normalized;
}

export async function resolveAnchorNodes(
  query: string,
  ctx: AuthContext,
  graph: RetrievalGraphQueryService = graphQueryService,
): Promise<RetrievalGraphNode[]> {
  return graph.resolveRetrievalAnchors(
    searchTerms(query, 'query'),
    null,
    RETRIEVAL_ANCHOR_LIMIT,
    ctx,
  );
}

export async function resolveAnchorNodeById(
  nodeId: string,
  ctx: AuthContext,
  graph: RetrievalGraphQueryService = graphQueryService,
): Promise<RetrievalGraphNode | null> {
  const nodes = await graph.resolveRetrievalAnchors(
    [],
    exactNodeId(nodeId),
    1,
    ctx,
  );
  return nodes[0] ?? null;
}

export async function traverseFrom(
  nodeId: string,
  intent: string,
  ctx: AuthContext,
  graph: RetrievalGraphQueryService = graphQueryService,
): Promise<RetrievalTraversal | null> {
  return graph.traverseRetrievalContext(
    exactNodeId(nodeId),
    searchTerms(intent, 'intent'),
    RETRIEVAL_MAX_HOPS,
    RETRIEVAL_NODE_LIMIT,
    ctx,
  );
}

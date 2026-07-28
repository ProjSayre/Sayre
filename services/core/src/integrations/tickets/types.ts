import type { TicketUpdatePayload } from '../../queue/bullmq';

export type TicketProvider = 'jira' | 'linear';
/**
 * 'file'/'feature' come from an explicit `[sayre:file:...]`/`[sayre:feature:...]`
 * tag parsed out of the ticket's own description (references.ts). 'node_id' is
 * an AI-inferred match (embedding similarity search against `code_embeddings`,
 * see the Python `TicketReferenceMatcher` + `ticket_cache.inferred_reference_*`
 * columns) — value is a File node's graph `uid` (the same value
 * `code_chunks.graph_node_id`/`code_embeddings.graph_node_id` store, and what
 * every read-side Cypher query aliases as `id` via `node.uid AS id` — see
 * graph-query/index.ts), not a path/name, so no separate node lookup is
 * needed to link it.
 */
export type TicketReferenceKind = 'file' | 'feature' | 'node_id';

export interface TicketReference {
  kind: TicketReferenceKind;
  value: string;
}

export interface NormalizedTicket {
  provider: TicketProvider;
  externalId: string;
  title: string;
  description: string | null;
  status: string | null;
  url: string | null;
  updatedAt: string;
  references: TicketReference[];
  raw: Record<string, unknown>;
}

export interface TicketProviderAdapter {
  readonly provider: TicketProvider;
  externalIdFromWebhook(payload: unknown): string | null;
  fetchTicket(externalId: string): Promise<NormalizedTicket>;
  updateTicket(
    externalId: string,
    patch: TicketUpdatePayload,
  ): Promise<NormalizedTicket>;
}

import type { MessageEnvelope } from '../queue/envelope';
import { assertValidEnvelope } from '../queue/envelope';
import type { TicketSyncPayload } from '../queue/bullmq';
import type { TicketCacheStore } from '../integrations/tickets/ticketCacheStore';
import type { TicketGraphStore } from '../integrations/tickets/graphTicketStore';
import { TicketProviderRegistry } from '../integrations/tickets/providerRegistry';

export interface TicketSyncDependencies {
  providers: TicketProviderRegistry;
  cache: TicketCacheStore;
  graph: TicketGraphStore;
}

export interface TicketSyncResult {
  provider: 'jira' | 'linear';
  externalTicketId: string;
  linkedNodes: number;
}

function validatePayload(payload: TicketSyncPayload): void {
  for (const [name, value] of [
    ['external_ticket_id', payload.external_ticket_id],
    ['repository_id', payload.repository_id],
    ['ref_name', payload.ref_name],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Ticket synchronization payload ${name} must be non-blank.`);
    }
  }
  if (payload.provider !== 'jira' && payload.provider !== 'linear') {
    throw new Error('Ticket synchronization payload provider is invalid.');
  }
  if (payload.direction !== 'inbound' && payload.direction !== 'outbound') {
    throw new Error('Ticket synchronization payload direction is invalid.');
  }
  if (payload.direction === 'outbound' && payload.patch === undefined) {
    throw new Error('Outbound ticket synchronization requires a patch.');
  }
}

export async function syncTicket(
  envelope: MessageEnvelope<TicketSyncPayload>,
  dependencies: TicketSyncDependencies,
): Promise<TicketSyncResult> {
  assertValidEnvelope(envelope);
  const payload = envelope.payload;
  validatePayload(payload);
  if (envelope.type !== `ticket.${payload.direction}`) {
    throw new Error('Ticket synchronization envelope type does not match its direction.');
  }

  const provider = dependencies.providers.get(payload.provider);
  const ticket = payload.direction === 'inbound'
    ? await provider.fetchTicket(payload.external_ticket_id)
    : await provider.updateTicket(payload.external_ticket_id, payload.patch ?? {});
  if (
    ticket.provider !== payload.provider ||
    ticket.externalId !== payload.external_ticket_id
  ) {
    throw new Error('Ticket provider returned an issue outside the requested identity.');
  }

  const write = {
    orgId: envelope.org_id,
    repositoryId: payload.repository_id,
    refName: payload.ref_name,
    ticket,
  };
  await dependencies.cache.upsert(write);
  const graph = await dependencies.graph.apply(write);
  return {
    provider: payload.provider,
    externalTicketId: payload.external_ticket_id,
    linkedNodes: graph.linkedNodes,
  };
}

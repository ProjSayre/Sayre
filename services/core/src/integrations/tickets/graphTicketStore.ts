import {
  createNeo4jWriteExecutor,
  graphIntegerToNumber,
  type GraphWriteExecutor,
} from '../../graph-write/neo4j';
import { ticketUid } from './identifiers';
import type { NormalizedTicket } from './types';

export interface TicketGraphWrite {
  orgId: string;
  repositoryId: string;
  refName: string;
  ticket: NormalizedTicket;
}

export interface TicketGraphStore {
  apply(input: TicketGraphWrite): Promise<{ linkedNodes: number }>;
  close(): Promise<void>;
}

export const UPSERT_TICKET_CYPHER = `
MERGE (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
SET ticket.external_id = $external_id,
    ticket.system = $provider,
    ticket.title = $title,
    ticket.status = $status,
    ticket.url = $url,
    ticket.synced_at = $synced_at,
    ticket.repo_id = $repo_id,
    ticket.ref_name = $ref_name
RETURN 1 AS upserted
`;

export const CLEAR_TICKET_REFERENCES_CYPHER = `
MATCH (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
MATCH (ticket)-[old:REFERENCES]->()
DELETE old
RETURN count(old) AS removed_references
`;

export const LINK_TICKET_REFERENCES_CYPHER = `
UNWIND $references AS reference
MATCH (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
MATCH (target {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
WHERE (reference.kind = 'file' AND target:File AND target.path = reference.value)
   OR (reference.kind = 'feature' AND target:Feature AND target.name = reference.value)
   OR (reference.kind = 'node_id' AND target:File AND target.uid = reference.value)
MERGE (ticket)-[link:REFERENCES]->(target)
SET link.org_id = $org_id
RETURN count(DISTINCT target) AS linked_nodes
`;

function parameters(input: TicketGraphWrite): Record<string, unknown> {
  return {
    org_id: input.orgId,
    repo_id: input.repositoryId,
    ref_name: input.refName,
    ticket_uid: ticketUid(input.orgId, input.ticket.provider, input.ticket.externalId),
    external_id: input.ticket.externalId,
    provider: input.ticket.provider,
    title: input.ticket.title,
    status: input.ticket.status,
    url: input.ticket.url,
    synced_at: input.ticket.updatedAt,
    references: input.ticket.references,
  };
}

export class Neo4jTicketGraphStore implements TicketGraphStore {
  constructor(private readonly executor: GraphWriteExecutor) {}

  async apply(input: TicketGraphWrite): Promise<{ linkedNodes: number }> {
    const params = parameters(input);
    await this.executor.run(input.orgId, UPSERT_TICKET_CYPHER, params, 'upserted');
    await this.executor.run(
      input.orgId,
      CLEAR_TICKET_REFERENCES_CYPHER,
      params,
      'removed_references',
    );
    if (input.ticket.references.length === 0) return { linkedNodes: 0 };
    const result = await this.executor.run(
      input.orgId,
      LINK_TICKET_REFERENCES_CYPHER,
      params,
      'linked_nodes',
    );
    const record = result.records[0];
    return {
      linkedNodes: record === undefined ? 0 : graphIntegerToNumber(record.get('linked_nodes')),
    };
  }

  async close(): Promise<void> {
    await this.executor.close();
  }
}

export async function createTicketGraphStore(): Promise<TicketGraphStore> {
  return new Neo4jTicketGraphStore(await createNeo4jWriteExecutor());
}

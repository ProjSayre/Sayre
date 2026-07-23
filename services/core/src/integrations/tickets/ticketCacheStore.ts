import { and, eq } from 'drizzle-orm';
import { getRuntimeDb } from '../../db/installations';
import { withOrgContext, type Db } from '../../db/client';
import { repositories, ticketCache } from '../../db/schema';
import { ticketUid } from './identifiers';
import type { NormalizedTicket } from './types';

export interface TicketCacheWrite {
  orgId: string;
  repositoryId: string;
  refName: string;
  ticket: NormalizedTicket;
}

export interface TicketCacheStore {
  upsert(input: TicketCacheWrite): Promise<void>;
}

export class PostgresTicketCacheStore implements TicketCacheStore {
  constructor(private readonly getDb: () => Promise<Db> = getRuntimeDb) {}

  async upsert(input: TicketCacheWrite): Promise<void> {
    const db = await this.getDb();
    await withOrgContext(db, input.orgId, async (transaction) => {
      const repository = await transaction
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.orgId, input.orgId),
        ))
        .limit(1);
      if (repository[0] === undefined) {
        throw new Error('Ticket synchronization repository is not registered for this organization.');
      }

      const syncedAt = new Date(input.ticket.updatedAt);
      if (Number.isNaN(syncedAt.valueOf())) {
        throw new Error('Ticket synchronization received an invalid update timestamp.');
      }
      const payload = {
        issue: input.ticket.raw,
        description: input.ticket.description,
        references: input.ticket.references,
        ref_name: input.refName,
      };
      await transaction
        .insert(ticketCache)
        .values({
          orgId: input.orgId,
          repoId: input.repositoryId,
          provider: input.ticket.provider,
          externalTicketId: input.ticket.externalId,
          title: input.ticket.title,
          status: input.ticket.status,
          url: input.ticket.url,
          graphNodeId: ticketUid(
            input.orgId,
            input.ticket.provider,
            input.ticket.externalId,
          ),
          payload,
          syncedAt,
        })
        .onConflictDoUpdate({
          target: [
            ticketCache.orgId,
            ticketCache.provider,
            ticketCache.externalTicketId,
          ],
          set: {
            repoId: input.repositoryId,
            title: input.ticket.title,
            status: input.ticket.status,
            url: input.ticket.url,
            graphNodeId: ticketUid(
              input.orgId,
              input.ticket.provider,
              input.ticket.externalId,
            ),
            payload,
            syncedAt,
            updatedAt: new Date(),
          },
        });
    });
  }
}

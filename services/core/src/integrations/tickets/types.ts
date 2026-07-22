import type { TicketUpdatePayload } from '../../queue/bullmq';

export type TicketProvider = 'jira' | 'linear';
export type TicketReferenceKind = 'file' | 'feature';

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

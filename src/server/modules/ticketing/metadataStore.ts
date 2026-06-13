import type { TicketSummary } from "../../types";

export class MetadataStore {
  private ticketSummaries = new Map<string, TicketSummary>();
  private idempotencyRecords = new Map<string, string>();
  private auditLog: Array<{ action: string; ticketId: string; actorId: string; at: string }> = [];

  cacheTicket(ticket: TicketSummary) {
    this.ticketSummaries.set(ticket.id, ticket);
  }

  getTicketIdForKey(key: string) {
    return this.idempotencyRecords.get(key);
  }

  recordIdempotency(key: string, ticketId: string) {
    this.idempotencyRecords.set(key, ticketId);
  }

  recordAudit(action: string, ticketId: string, actorId: string) {
    this.auditLog.push({ action, ticketId, actorId, at: new Date().toISOString() });
  }
}

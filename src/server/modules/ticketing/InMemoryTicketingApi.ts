import { randomUUID } from "node:crypto";
import { getRequestType, validateRequestFields } from "./catalog";
import { MetadataStore } from "./metadataStore";
import { mapInternalStatus } from "./status";
import type {
  CreateTicketInput,
  AdminTicketFilters,
  AdminTicketUpdate,
  PortalUser,
  TicketComment,
  TicketDetail,
  TicketFilters,
  TicketSummary,
  TicketingApi
} from "../../types";
import { canViewTicket, filterVisibleTickets } from "./visibility";

function nowIso() {
  return new Date().toISOString();
}

function summarize(ticket: TicketDetail): TicketSummary {
  const { description: _description, comments: _comments, metadata: _metadata, ...summary } = ticket;
  return summary;
}

export class InMemoryTicketingApi implements TicketingApi {
  private tickets = new Map<string, TicketDetail>();

  constructor(seed: TicketDetail[] = [], private readonly metadataStore = new MetadataStore()) {
    for (const ticket of seed) {
      this.tickets.set(ticket.id, ticket);
      this.metadataStore.cacheTicket(summarize(ticket));
    }
  }

  async createTicket(input: CreateTicketInput, requester: PortalUser): Promise<TicketDetail> {
    const requestType = getRequestType(input.requestType);
    if (!requestType) {
      throw new Error(`Unknown request type: ${input.requestType}`);
    }

    if (input.idempotencyKey) {
      const existingId = this.metadataStore.getTicketIdForKey(input.idempotencyKey);
      if (existingId) {
        const existingTicket = this.tickets.get(existingId);
        if (existingTicket) {
          return existingTicket;
        }
      }
    }

    const fields = validateRequestFields(input.requestType, input.fields);
    const createdAt = nowIso();
    const ticket: TicketDetail = {
      id: `DEVOPS-${1000 + this.tickets.size + 1}`,
      title: fields.title ?? requestType.name,
      requestType: requestType.name,
      requesterId: requester.id,
      requesterName: requester.displayName,
      teamGroups: [requestType.ownerTeam, ...requester.groups],
      rawStatus: "New",
      stage: mapInternalStatus("New"),
      assigneeId: "",
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
      description: fields.description ?? "",
      metadata: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])),
      comments: []
    };

    this.tickets.set(ticket.id, ticket);
    this.metadataStore.cacheTicket(summarize(ticket));
    this.metadataStore.recordAudit("ticket.create", ticket.id, requester.id);
    if (input.idempotencyKey) {
      this.metadataStore.recordIdempotency(input.idempotencyKey, ticket.id);
    }
    return ticket;
  }

  async listTickets(user: PortalUser, filters: TicketFilters): Promise<TicketSummary[]> {
    const allTickets = [...this.tickets.values()].map(summarize);
    return filterVisibleTickets(user, allTickets, filters.scope)
      .filter((ticket) => (filters.status ? ticket.stage === filters.status : true))
      .filter((ticket) => {
        if (!filters.query) {
          return true;
        }
        const query = filters.query.toLowerCase();
        return [ticket.id, ticket.title, ticket.requestType, ticket.requesterName].some((value) =>
          value.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  async getTicket(ticketId: string, user: PortalUser): Promise<TicketDetail | null> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || !canViewTicket(user, ticket)) {
      return null;
    }
    return ticket;
  }

  async addComment(ticketId: string, user: PortalUser, body: string): Promise<TicketComment> {
    const ticket = await this.getTicket(ticketId, user);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const createdAt = nowIso();
    const comment: TicketComment = {
      id: randomUUID(),
      authorName: user.displayName,
      authorId: user.id,
      body,
      createdAt
    };
    ticket.comments.push(comment);
    ticket.updatedAt = createdAt;
    ticket.lastActivityAt = createdAt;
    this.metadataStore.cacheTicket(summarize(ticket));
    this.metadataStore.recordAudit("ticket.comment", ticket.id, user.id);
    return comment;
  }

  async listAdminTickets(filters: AdminTicketFilters): Promise<TicketSummary[]> {
    return [...this.tickets.values()]
      .map(summarize)
      .filter((ticket) => (filters.status ? ticket.stage === filters.status : true))
      .filter((ticket) => {
        if (!filters.query) {
          return true;
        }
        const query = filters.query.toLowerCase();
        return [ticket.id, ticket.title, ticket.requestType, ticket.requesterName, ticket.teamGroups.join(" ")].some(
          (value) => value.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  async getAdminTicket(ticketId: string): Promise<TicketDetail | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async updateAdminTicket(ticketId: string, admin: PortalUser, update: AdminTicketUpdate): Promise<TicketDetail> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const updatedAt = nowIso();
    if (update.title !== undefined) {
      ticket.title = update.title;
    }
    if (update.description !== undefined) {
      ticket.description = update.description;
    }
    if (update.stage !== undefined) {
      ticket.stage = update.stage;
      ticket.rawStatus = update.rawStatus ?? update.stage;
    } else if (update.rawStatus !== undefined) {
      ticket.rawStatus = update.rawStatus;
      ticket.stage = mapInternalStatus(update.rawStatus);
    }
    if (update.teamGroups !== undefined) {
      ticket.teamGroups = update.teamGroups;
    }
    if (update.assigneeId !== undefined) {
      ticket.assigneeId = update.assigneeId;
    }
    ticket.updatedAt = updatedAt;
    ticket.lastActivityAt = updatedAt;
    this.metadataStore.cacheTicket(summarize(ticket));
    this.metadataStore.recordAudit("ticket.admin.update", ticket.id, admin.id);
    return ticket;
  }

  async addAdminComment(ticketId: string, admin: PortalUser, body: string): Promise<TicketComment> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const createdAt = nowIso();
    const comment: TicketComment = {
      id: randomUUID(),
      authorName: admin.displayName,
      authorId: admin.id,
      body,
      createdAt
    };
    ticket.comments.push(comment);
    ticket.updatedAt = createdAt;
    ticket.lastActivityAt = createdAt;
    this.metadataStore.cacheTicket(summarize(ticket));
    this.metadataStore.recordAudit("ticket.admin.comment", ticket.id, admin.id);
    return comment;
  }
}

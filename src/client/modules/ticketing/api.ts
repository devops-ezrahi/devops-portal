import { request } from "../../api";
import type { AdminTicketUpdate, RequestTypeDefinition, TicketDetail, TicketSummary } from "../../../server/types";

export function getRequestTypes() {
  return request<{ requestTypes: RequestTypeDefinition[] }>("/api/request-types");
}

export function listTickets(params: { scope: "mine" | "team"; status?: string; query?: string }) {
  const search = new URLSearchParams({ scope: params.scope });
  if (params.status) search.set("status", params.status);
  if (params.query) search.set("query", params.query);
  return request<{ tickets: TicketSummary[] }>(`/api/tickets?${search}`);
}

export function getTicket(id: string) {
  return request<{ ticket: TicketDetail }>(`/api/tickets/${id}`);
}

export function createTicket(payload: { requestType: string; fields: Record<string, string>; idempotencyKey: string }) {
  return request<{ ticket: TicketDetail }>("/api/tickets", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function addComment(ticketId: string, body: string) {
  return request<{ comment: TicketDetail["comments"][number] }>(`/api/tickets/${ticketId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body })
  });
}

export function listAdminTickets(params: { status?: string; query?: string }) {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.query) search.set("query", params.query);
  return request<{ tickets: TicketSummary[] }>(`/api/admin/tickets?${search}`);
}

export function getAdminTicket(id: string) {
  return request<{ ticket: TicketDetail }>(`/api/admin/tickets/${id}`);
}

export function updateAdminTicket(ticketId: string, payload: AdminTicketUpdate) {
  return request<{ ticket: TicketDetail }>(`/api/admin/tickets/${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function addAdminComment(ticketId: string, body: string) {
  return request<{ comment: TicketDetail["comments"][number] }>(`/api/admin/tickets/${ticketId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body })
  });
}

import { priorityResponseHours } from "./config";
import type { TicketSummary } from "../../../server/types";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function stageClass(stage: string) {
  return `stage stage-${stage.toLowerCase().replaceAll(" ", "-")}`;
}

export function priorityClass(priority: string) {
  return `priority priority-${priority.toLowerCase()}`;
}

export function isDone(ticket: TicketSummary) {
  return ticket.stage === "Closed" || ticket.stage === "Cancelled";
}

/** When the priority's response window runs out. */
export function slaDueAt(ticket: TicketSummary) {
  return new Date(ticket.createdAt).getTime() + priorityResponseHours[ticket.priority] * 3_600_000;
}

// The clock stops the moment the customer hears back — either the team
// replied, or the ticket moved off Submitted (picked up, closed, cancelled).
// Single source of truth so the countdown and the Overdue badge cannot
// disagree about whether the promise is still outstanding.
export function slaRunning(ticket: TicketSummary) {
  return ticket.stage === "Submitted" && !ticket.respondedAt;
}

export function isOverdue(ticket: TicketSummary) {
  return slaRunning(ticket) && Date.now() > slaDueAt(ticket);
}

/** Milliseconds left, or `null` once the clock has stopped or run out. */
export function slaRemainingMs(ticket: TicketSummary) {
  if (!slaRunning(ticket)) return null;
  const remaining = slaDueAt(ticket) - Date.now();
  return remaining > 0 ? remaining : null;
}

/** "3h", "3h 20m", "45m" — minutes only shown when they add something. */
export function formatSlaRemaining(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const statusMessagePrefix = "[status] ";

export function isStatusMessage(body: string) {
  return body.startsWith(statusMessagePrefix);
}

export function statusMessage(body: string) {
  return `${statusMessagePrefix}${body}`;
}

export function statusMessageText(body: string) {
  return body.slice(statusMessagePrefix.length);
}

// Deep-link support: /tickets/<id> so a ticket URL can be shared and opens
// straight to that ticket instead of just the module's list view.
export function getTicketIdFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/tickets\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setTicketIdInUrl(id: string) {
  const path = `/tickets/${encodeURIComponent(id)}`;
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
  }
}

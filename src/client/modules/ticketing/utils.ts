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

// "Answered" is approximated by the ticket leaving Submitted — that is the
// only stage where nobody has picked it up yet, so it is the one the
// response-time promise is actually about.
export function isOverdue(ticket: TicketSummary) {
  return ticket.stage === "Submitted" && Date.now() > slaDueAt(ticket);
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

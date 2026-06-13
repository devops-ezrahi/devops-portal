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

export function isDone(ticket: TicketSummary) {
  return ticket.stage === "Resolved" || ticket.stage === "Closed";
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

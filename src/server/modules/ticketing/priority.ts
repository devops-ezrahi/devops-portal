import type { TicketPriority } from "../../types";

export const ticketPriorities: TicketPriority[] = ["Highest", "High", "Medium", "Low", "Lowest"];

/**
 * Jira has no SLA of its own without Jira Service Management — the
 * response-time promise attached to each priority is this app's.
 */
export const priorityResponseHours: Record<TicketPriority, number> = {
  Highest: 1,
  High: 4,
  Medium: 8,
  Low: 24,
  Lowest: 72
};

export const defaultPriority: TicketPriority = "Medium";

/** The instance's own priority names — the portal shows its five, Jira is sent these. */
export const jiraPriorityName: Record<TicketPriority, string> = {
  Lowest: "Trivial",
  Low: "Low",
  Medium: "Normal",
  High: "Warning",
  Highest: "Major"
};

/** A Jira priority name back to the portal's, accepting the portal's own names too. */
export function parsePriority(value: unknown): TicketPriority {
  const fromJira = ticketPriorities.find((p) => jiraPriorityName[p] === value);
  if (fromJira) return fromJira;
  return ticketPriorities.includes(value as TicketPriority) ? (value as TicketPriority) : defaultPriority;
}

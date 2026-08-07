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

export function parsePriority(value: unknown): TicketPriority {
  return ticketPriorities.includes(value as TicketPriority) ? (value as TicketPriority) : defaultPriority;
}

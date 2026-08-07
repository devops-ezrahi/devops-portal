import type { CustomerStage, TicketPriority } from "../../../server/types";

export const stages: Array<CustomerStage | ""> = [
  "",
  "Submitted",
  "In Progress",
  "Waiting on Customer",
  "Closed",
  "Cancelled"
];

export const priorities: TicketPriority[] = ["Highest", "High", "Medium", "Low", "Lowest"];

export const defaultPriority: TicketPriority = "Medium";

/** Response-time promise per priority — mirrors the server's `priority.ts`. */
export const priorityResponseHours: Record<TicketPriority, number> = {
  Highest: 1,
  High: 4,
  Medium: 8,
  Low: 24,
  Lowest: 72
};

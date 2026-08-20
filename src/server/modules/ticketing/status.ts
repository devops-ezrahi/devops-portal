import type { CustomerStage } from "../../types";

// Triage-ish backend statuses collapse into Submitted: the ticket has
// arrived and nobody is working it yet, which is all the customer needs.
const normalizedMappings: Record<string, CustomerStage> = {
  new: "Submitted",
  open: "Submitted",
  submitted: "Submitted",
  intake: "Submitted",
  triage: "Submitted",
  triaged: "Submitted",
  acknowledged: "Submitted",
  assigned: "Submitted",
  "in progress": "In Progress",
  implementing: "In Progress",
  development: "In Progress",
  "work in progress": "In Progress",
  "in review": "In Review",
  "pull request": "In Review",
  review: "In Review",
  "waiting for customer": "Waiting on Customer",
  "waiting on customer": "Waiting on Customer",
  "customer action required": "Waiting on Customer",
  stuck: "Waiting on Customer",
  blocked: "Waiting on Customer",
  resolved: "Closed",
  done: "Closed",
  complete: "Closed",
  completed: "Closed",
  closed: "Closed",
  cancelled: "Cancelled",
  canceled: "Cancelled"
};

export function mapInternalStatus(rawStatus: string): CustomerStage {
  const normalized = rawStatus.trim().toLowerCase().replace(/[_-]+/g, " ");
  return normalizedMappings[normalized] ?? "Submitted";
}

export const customerStages: CustomerStage[] = [
  "Submitted",
  "In Progress",
  "In Review",
  "Waiting on Customer",
  "Closed",
  "Cancelled"
];

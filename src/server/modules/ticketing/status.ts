import type { CustomerStage } from "../../types";

const normalizedMappings: Record<string, CustomerStage> = {
  new: "Submitted",
  open: "Submitted",
  submitted: "Submitted",
  intake: "Triaged",
  triage: "Triaged",
  triaged: "Triaged",
  acknowledged: "Triaged",
  assigned: "Triaged",
  "in progress": "In Progress",
  implementing: "In Progress",
  development: "In Progress",
  "work in progress": "In Progress",
  "waiting for customer": "Waiting on Customer",
  "waiting on customer": "Waiting on Customer",
  "customer action required": "Waiting on Customer",
  blocked: "Waiting on Customer",
  resolved: "Resolved",
  done: "Resolved",
  complete: "Resolved",
  completed: "Resolved",
  closed: "Closed",
  cancelled: "Closed",
  canceled: "Closed"
};

export function mapInternalStatus(rawStatus: string): CustomerStage {
  const normalized = rawStatus.trim().toLowerCase().replace(/[_-]+/g, " ");
  return normalizedMappings[normalized] ?? "Triaged";
}

export const customerStages: CustomerStage[] = [
  "Submitted",
  "Triaged",
  "In Progress",
  "Waiting on Customer",
  "Resolved",
  "Closed"
];

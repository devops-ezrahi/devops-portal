import type { CustomerStage } from "../../../server/types";

export const stages: Array<CustomerStage | ""> = [
  "",
  "Submitted",
  "Triaged",
  "In Progress",
  "Waiting on Customer",
  "Resolved",
  "Closed"
];

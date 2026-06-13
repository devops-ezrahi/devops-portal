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

export const devopsAdmins = [
  { id: "morgan", name: "Morgan Admin" },
  { id: "taylor", name: "Taylor DevOps" },
  { id: "casey", name: "Casey Platform" },
  { id: "sam", name: "Sam Release" }
];

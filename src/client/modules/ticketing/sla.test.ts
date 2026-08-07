import { describe, expect, it } from "vitest";
import { isDone, isOverdue } from "./utils";
import type { TicketSummary } from "../../../server/types";

function ticket(overrides: Partial<TicketSummary>): TicketSummary {
  return {
    id: "DEVOPS-1",
    title: "t",
    requestType: "Incident Support",
    requesterId: "u",
    requesterName: "U",
    teamGroups: [],
    rawStatus: "New",
    stage: "Submitted",
    priority: "Medium",
    assigneeId: "",
    assigneeName: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides
  };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("isOverdue", () => {
  it("flags a Submitted ticket past its priority's response window", () => {
    // Highest promises 1h.
    expect(isOverdue(ticket({ priority: "Highest", createdAt: hoursAgo(2) }))).toBe(true);
    expect(isOverdue(ticket({ priority: "Highest", createdAt: hoursAgo(0.5) }))).toBe(false);
  });

  it("scales the window with priority", () => {
    // 12h old: past Medium's 8h, still inside Low's 24h.
    expect(isOverdue(ticket({ priority: "Medium", createdAt: hoursAgo(12) }))).toBe(true);
    expect(isOverdue(ticket({ priority: "Low", createdAt: hoursAgo(12) }))).toBe(false);
  });

  it("stops flagging once the ticket has been picked up", () => {
    const old = { priority: "Highest" as const, createdAt: hoursAgo(99) };
    expect(isOverdue(ticket({ ...old, stage: "In Progress" }))).toBe(false);
    expect(isOverdue(ticket({ ...old, stage: "Closed" }))).toBe(false);
    expect(isOverdue(ticket({ ...old, stage: "Cancelled" }))).toBe(false);
  });
});

describe("isDone", () => {
  it("treats both terminal stages as done", () => {
    expect(isDone(ticket({ stage: "Closed" }))).toBe(true);
    expect(isDone(ticket({ stage: "Cancelled" }))).toBe(true);
    expect(isDone(ticket({ stage: "Submitted" }))).toBe(false);
    expect(isDone(ticket({ stage: "Waiting on Customer" }))).toBe(false);
  });
});

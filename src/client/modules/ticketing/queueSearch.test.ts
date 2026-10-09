import { describe, expect, it } from "vitest";
import { matchesQuery } from "./AdminTicketingView";
import type { TicketSummary } from "../../../server/types";

const ticket = {
  id: "OPS-142",
  title: "Open port 8443 on the shop route",
  requestType: "Networking",
  requesterId: "dana",
  requesterName: "Dana Levi",
  assigneeId: "omer",
  assigneeName: "Omer Cohen",
  stage: "In Progress",
  priority: "High",
  rawStatus: "In Progress"
} as TicketSummary;

describe("matchesQuery", () => {
  it("matches everything when empty", () => {
    expect(matchesQuery(ticket, "  ")).toBe(true);
  });
  it("matches id, title, people and type, case-insensitively", () => {
    for (const q of ["ops-142", "PORT 8443", "dana", "Cohen", "networking", "high"]) {
      expect(matchesQuery(ticket, q)).toBe(true);
    }
  });
  it("needs every word, in any order", () => {
    expect(matchesQuery(ticket, "shop dana")).toBe(true);
    expect(matchesQuery(ticket, "shop moshe")).toBe(false);
  });
});

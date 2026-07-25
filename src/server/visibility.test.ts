import { describe, expect, it } from "vitest";
import { canViewTicket, filterVisibleTickets } from "./modules/ticketing/visibility";
import type { PortalUser, TicketSummary } from "./types";

const user: PortalUser = {
  id: "u-alex",
  email: "alex@example.com",
  displayName: "Alex",
  groups: ["team-alpha"]
};

const tickets = [
  { id: "own", requesterId: "u-alex", teamGroups: ["team-beta"] },
  { id: "team", requesterId: "u-riley", teamGroups: ["team-alpha"] },
  { id: "hidden", requesterId: "u-jordan", teamGroups: ["team-gamma"] }
] as TicketSummary[];

describe("visibility", () => {
  it("allows requesters and matching team groups", () => {
    expect(canViewTicket(user, tickets[0])).toBe(true);
    expect(canViewTicket(user, tickets[1])).toBe(true);
    expect(canViewTicket(user, tickets[2])).toBe(false);
  });

  it("filters mine and team scopes differently", () => {
    expect(filterVisibleTickets(user, tickets, "mine").map((ticket) => ticket.id)).toEqual(["own"]);
    expect(filterVisibleTickets(user, tickets, "team").map((ticket) => ticket.id)).toEqual(["own", "team"]);
  });
});

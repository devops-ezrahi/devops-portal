import type { PortalUser, TicketSummary } from "../../types";

export function canViewTicket(user: PortalUser, ticket: Pick<TicketSummary, "requesterId" | "teamGroups">) {
  if (ticket.requesterId === user.id) {
    return true;
  }
  return ticket.teamGroups.some((group) => user.groups.includes(group));
}

export function filterVisibleTickets<T extends Pick<TicketSummary, "requesterId" | "teamGroups">>(
  user: PortalUser,
  tickets: T[],
  scope: "mine" | "team"
) {
  return tickets.filter((ticket) => {
    if (scope === "mine") {
      return ticket.requesterId === user.id;
    }
    return canViewTicket(user, ticket);
  });
}

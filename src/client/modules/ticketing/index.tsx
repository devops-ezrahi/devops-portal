import { Filter } from "lucide-react";
import type { PortalModule, ModuleViewProps } from "../../moduleTypes";
import { AdminTicketingView } from "./AdminTicketingView";
import { UserTicketingView } from "./UserTicketingView";

function TicketingView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  if (isAdmin) {
    return <AdminTicketingView key={refreshKey} user={user} onError={onError} />;
  }
  return <UserTicketingView key={refreshKey} onError={onError} />;
}

export const ticketingModule: PortalModule = {
  id: "ticketing",
  userNav: { label: "Tickets", Icon: Filter },
  adminNav: { label: "Tickets", Icon: Filter },
  View: TicketingView
};

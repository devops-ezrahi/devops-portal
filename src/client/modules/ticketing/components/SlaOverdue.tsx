import { AlarmClock } from "lucide-react";
import { priorityResponseHours } from "../config";
import { formatDate, slaDueAt } from "../utils";
import type { TicketSummary } from "../../../../server/types";

/** Small marker for a ticket still unanswered past its priority's window. */
export function SlaOverdue({ ticket }: { ticket: TicketSummary }) {
  return (
    <span
      className="sla-overdue"
      title={`${ticket.priority} priority promises a reply within ${priorityResponseHours[ticket.priority]}h — due ${formatDate(new Date(slaDueAt(ticket)).toISOString())}`}
    >
      <AlarmClock size={12} aria-hidden="true" /> Overdue
    </span>
  );
}

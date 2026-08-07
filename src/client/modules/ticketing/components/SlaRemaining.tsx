import { priorityResponseHours } from "../config";
import { formatSlaRemaining, slaRemainingMs } from "../utils";
import type { TicketSummary } from "../../../../server/types";

const ONE_HOUR_MS = 3_600_000;

/**
 * Time left to answer, for the admin queue. Renders nothing once the clock
 * has stopped (team replied, or the ticket moved off Submitted) or once it
 * has run out — past due, the Overdue badge is the signal instead.
 *
 * ponytail: no timer of its own. The queue already polls every 8s and
 * re-renders, which is finer resolution than a minutes-granularity label
 * needs. Add an interval only if the poll ever goes away.
 */
export function SlaRemaining({ ticket }: { ticket: TicketSummary }) {
  const remaining = slaRemainingMs(ticket);
  if (remaining === null) return null;
  const urgent = remaining < ONE_HOUR_MS;
  return (
    <small
      className={urgent ? "sla-remaining urgent" : "sla-remaining"}
      title={`${ticket.priority} priority promises a reply within ${priorityResponseHours[ticket.priority]}h`}
    >
      {formatSlaRemaining(remaining)} left
    </small>
  );
}

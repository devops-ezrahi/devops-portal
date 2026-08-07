import { useEffect, useMemo, useRef, useState } from "react";
import {
  addAdminComment,
  getAdminTicket,
  getAssignees,
  listAdminTickets,
  updateAdminTicket
} from "./api";
import { log, error as logError } from "../../log";
import { AdminTicketDetail } from "./components/AdminTicketDetail";
import { SlaOverdue } from "./components/SlaOverdue";
import { SlaRemaining } from "./components/SlaRemaining";
import { getTicketIdFromUrl, isDone, isOverdue, priorityClass, setTicketIdInUrl, stageClass, statusMessage } from "./utils";
import type { AssigneeCandidate, PortalUser, TicketDetail, TicketSummary } from "../../../server/types";

const POLL_INTERVAL_MS = 8000;

function TicketRow({
  ticket,
  isSelected,
  isUnread,
  onOpen
}: {
  ticket: TicketSummary;
  isSelected: boolean;
  isUnread: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      className={[
        "ticket-row",
        isSelected && "selected",
        isUnread && "unread"
      ].filter(Boolean).join(" ")}
      onClick={() => onOpen(ticket.id)}
    >
      {isUnread && <span className="update-dot" aria-label="Updated" />}
      <span className="badge-row">
        <span className={stageClass(ticket.stage)}>{ticket.stage}</span>
        <span className={priorityClass(ticket.priority)}>{ticket.priority}</span>
        {isOverdue(ticket) && <SlaOverdue ticket={ticket} />}
      </span>
      <strong>{ticket.title}</strong>
      <SlaRemaining ticket={ticket} />
      <div className="ticket-row-meta">
        <small>{ticket.id}</small>
        {ticket.assigneeId
          ? <small className="ticket-row-assignee assigned">{ticket.assigneeName || ticket.assigneeId}</small>
          : <small className="ticket-row-assignee unassigned">Unassigned</small>
        }
      </div>
    </button>
  );
}

export function AdminTicketingView({
  user,
  onError
}: {
  user: PortalUser;
  onError: (message: string) => void;
}) {
  const [adminTickets, setAdminTickets] = useState<TicketSummary[]>([]);
  const [selectedAdminTicket, setSelectedAdminTicket] = useState<TicketDetail | null>(null);
  const [assignees, setAssignees] = useState<AssigneeCandidate[]>([]);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const lastActivityRef = useRef<Map<string, string>>(new Map());
  const hasLoadedRef = useRef(false);

  selectedIdRef.current = selectedAdminTicket?.id;

  useEffect(() => {
    log("ticketing/admin", "queue mounted", { user: user.id, groups: user.groups });
    refreshAdminTickets().catch((err: Error) => {
      logError("ticketing/admin", "initial queue load failed", err);
      onError(err.message);
    });
    getAssignees()
      .then((result) => {
        log("ticketing/admin", `assignees: ${result.assignees.length}`, result.assignees.map((a) => a.id));
        setAssignees(result.assignees);
      })
      .catch((err: Error) => {
        logError("ticketing/admin", "getAssignees failed", err);
        onError(err.message);
      });
    const deepLinkedId = getTicketIdFromUrl();
    if (deepLinkedId) {
      log("ticketing/admin", "deep link → opening ticket", deepLinkedId);
      openAdminTicket(deepLinkedId).catch((err: Error) => onError(err.message));
    }
  }, []);

  // Short polling so an assignment/status change made by another admin (or
  // status updates the requester sees) show up without a manual refresh.
  // ponytail: a few lines beats a WebSocket server for this team's traffic —
  // revisit only if "every few seconds" stops being live enough.
  useEffect(() => {
    log("ticketing/admin", `polling every ${POLL_INTERVAL_MS}ms`, { watching: selectedAdminTicket?.id ?? "(queue only)" });
    const interval = window.setInterval(() => {
      log("ticketing/admin", "poll tick");
      refreshAdminTickets().catch((err: Error) => logError("ticketing/admin", "poll refresh failed", err));
      if (selectedAdminTicket) {
        getAdminTicket(selectedAdminTicket.id)
          .then((result) => setSelectedAdminTicket(result.ticket))
          .catch((err: Error) => logError("ticketing/admin", "poll ticket reload failed", selectedAdminTicket.id, err));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      log("ticketing/admin", "stopping poll");
      window.clearInterval(interval);
    };
  }, [selectedAdminTicket?.id]);

  // Diff against the last-seen activity timestamp per ticket so the unread
  // dot reflects changes the *other side* made (a comment, a reassignment,
  // or a brand-new ticket) while this ticket wasn't open here — not a
  // ticket this admin is currently looking at or just edited themselves.
  // Skip flagging anything on the very first load (nothing was "previous"
  // yet, so every existing ticket would otherwise light up as unread).
  function markChangedSinceLastSeen(tickets: TicketSummary[]) {
    const previous = lastActivityRef.current;
    const currentlyOpenId = selectedIdRef.current;
    const isFirstLoad = !hasLoadedRef.current;
    const changedIds = tickets
      .filter((t) => {
        if (t.id === currentlyOpenId) return false;
        const before = previous.get(t.id);
        if (before === undefined) return !isFirstLoad;
        return before !== t.lastActivityAt;
      })
      .map((t) => t.id);
    hasLoadedRef.current = true;
    if (isFirstLoad) log("ticketing/admin", "first load — not flagging anything unread");
    if (changedIds.length > 0) {
      log("ticketing/admin", "unread — changed since last seen", changedIds);
      setUnreadIds((current) => {
        const next = new Set(current);
        changedIds.forEach((id) => next.add(id));
        return next;
      });
    }
    lastActivityRef.current = new Map(tickets.map((t) => [t.id, t.lastActivityAt]));
  }

  async function refreshAdminTickets() {
    const result = await listAdminTickets({});
    log("ticketing/admin", `queue: ${result.tickets.length} tickets`, {
      unassigned: result.tickets.filter((t) => !t.assigneeId).length,
      rows: result.tickets.map((t) => `${t.id}:${t.stage}:${t.assigneeId ?? "-"}`),
    });
    markChangedSinceLastSeen(result.tickets);
    setAdminTickets(result.tickets);
    if (selectedAdminTicket && !result.tickets.some((t) => t.id === selectedAdminTicket.id)) {
      log("ticketing/admin", "selected ticket left the queue — clearing selection", selectedAdminTicket.id);
      setSelectedAdminTicket(null);
    }
  }

  async function openAdminTicket(id: string) {
    log("ticketing/admin", "opening ticket", id);
    setUnreadIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const result = await getAdminTicket(id);
    setSelectedAdminTicket(result.ticket);
    setTicketIdInUrl(id);
  }

  async function reloadAdminTicket(id: string) {
    log("ticketing/admin", "reloading ticket", id);
    const result = await getAdminTicket(id);
    setSelectedAdminTicket(result.ticket);
    await refreshAdminTickets();
  }

  const filteredTickets = useMemo(() => {
    if (showAll) return adminTickets;
    return adminTickets.filter((t) => !t.assigneeId || t.assigneeId === user.id);
  }, [adminTickets, showAll, user.id]);

  const activeTickets = useMemo(() => filteredTickets.filter((t) => !isDone(t)), [filteredTickets]);
  const doneTickets = useMemo(() => filteredTickets.filter(isDone), [filteredTickets]);

  function handleOpenTicket(id: string) {
    openAdminTicket(id).catch((err: Error) => onError(err.message));
  }

  return (
    <div className="workspace-grid">
      <div className="ticket-column">
        <div className="ticket-list-header">
          <h1>Queue</h1>
          <button
            className="ghost-button"
            onClick={() => {
              log("ticketing/admin", `filter → ${showAll ? "mine & unassigned" : "all tickets"}`);
              setShowAll((v) => !v);
            }}
          >
            {showAll ? "Mine & Unassigned" : "All tickets"}
          </button>
        </div>
        <section className="ticket-list-panel" aria-label="Admin tickets">
          <div className="ticket-list">
            {activeTickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} isSelected={selectedAdminTicket?.id === ticket.id} isUnread={unreadIds.has(ticket.id)} onOpen={handleOpenTicket} />)}
            {activeTickets.length === 0 && <div className="empty-state">No tickets.</div>}
          </div>
        </section>

        {doneTickets.length > 0 && (
          <details className="ticket-list-panel done-panel" aria-label="Done admin tickets">
            <summary>Done</summary>
            <div className="ticket-list">
              {doneTickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} isSelected={selectedAdminTicket?.id === ticket.id} isUnread={unreadIds.has(ticket.id)} onOpen={handleOpenTicket} />)}
            </div>
          </details>
        )}
      </div>

      <section className="detail-panel" aria-label="Ticket detail">
        {selectedAdminTicket ? (
          <AdminTicketDetail
            key={selectedAdminTicket.id}
            assignee={selectedAdminTicket.assigneeId}
            assignees={assignees}
            currentUserId={user.id}
            currentUserName={user.displayName}
            onAssigneeChange={async (assigneeId, assigneeName) => {
              const ownerName = assigneeName || "Unassigned";
              log("ticketing/admin", "reassigning ticket", selectedAdminTicket.id, {
                from: selectedAdminTicket.assigneeId ?? "-",
                to: assigneeId || "-",
                ownerName,
              });
              await updateAdminTicket(selectedAdminTicket.id, { assigneeId, assigneeName });
              await addAdminComment(selectedAdminTicket.id, statusMessage(`Owner changed to ${ownerName}.`));
              await reloadAdminTicket(selectedAdminTicket.id);
            }}
            onReload={() => reloadAdminTicket(selectedAdminTicket.id)}
            ticket={selectedAdminTicket}
          />
        ) : (
          <div className="empty-state">Select a ticket.</div>
        )}
      </section>
    </div>
  );
}

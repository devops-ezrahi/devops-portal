import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { log, error as logError } from "../../log";
import { getRequestTypes, getTicket, listTickets } from "./api";
import { CreateTicketView } from "./components/CreateTicketView";
import { TicketDetailView } from "./components/TicketDetailView";
import { getTicketIdFromUrl, isDone, priorityClass, setTicketIdInUrl, stageClass } from "./utils";
import type { RequestTypeDefinition, TicketDetail, TicketSummary } from "../../../server/types";

const POLL_INTERVAL_MS = 8000;

export function UserTicketingView({ onError }: { onError: (message: string) => void }) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<TicketDetail | null>(null);
  const [requestTypes, setRequestTypes] = useState<RequestTypeDefinition[]>([]);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isModalClosing, setIsModalClosing] = useState(false);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const lastActivityRef = useRef<Map<string, string>>(new Map());

  selectedIdRef.current = selectedTicket?.id;

  useEffect(() => {
    log("ticketing", "user view mounted — loading catalog + tickets");
    Promise.all([getRequestTypes(), listTickets({ scope: "mine" })])
      .then(([catalog, result]) => {
        log("ticketing", `catalog: ${catalog.requestTypes.length} request types`, catalog.requestTypes.map((t) => t.id));
        log("ticketing", `my tickets: ${result.tickets.length}`, result.tickets.map((t) => `${t.id}:${t.stage}`));
        setRequestTypes(catalog.requestTypes);
        markChangedSinceLastSeen(result.tickets);
        setTickets(result.tickets);
      })
      .catch((err: Error) => {
        logError("ticketing", "initial load failed", err);
        onError(err.message);
      });
    const deepLinkedId = getTicketIdFromUrl();
    if (deepLinkedId) {
      log("ticketing", "deep link → opening ticket", deepLinkedId);
      openTicket(deepLinkedId).catch((err: Error) => onError(err.message));
    }
  }, []);

  // Diff against the last-seen activity timestamp per ticket so the unread
  // dot reflects changes an admin made (a status update, a message) while
  // this ticket wasn't open here — see AdminTicketingView for the matching
  // admin-side logic.
  function markChangedSinceLastSeen(nextTickets: TicketSummary[]) {
    const previous = lastActivityRef.current;
    const currentlyOpenId = selectedIdRef.current;
    const changedIds = nextTickets
      .filter((t) => {
        const before = previous.get(t.id);
        return before !== undefined && before !== t.lastActivityAt && t.id !== currentlyOpenId;
      })
      .map((t) => t.id);
    if (changedIds.length > 0) {
      log("ticketing", "unread — changed since last seen", changedIds);
      setUnreadIds((current) => {
        const next = new Set(current);
        changedIds.forEach((id) => next.add(id));
        return next;
      });
    }
    lastActivityRef.current = new Map(nextTickets.map((t) => [t.id, t.lastActivityAt]));
  }

  async function refreshTickets() {
    const result = await listTickets({ scope: "mine" });
    log("ticketing", `refreshed: ${result.tickets.length} tickets`, result.tickets.map((t) => `${t.id}:${t.stage}`));
    markChangedSinceLastSeen(result.tickets);
    setTickets(result.tickets);
    if (selectedTicket && !result.tickets.some((t) => t.id === selectedTicket.id)) {
      log("ticketing", "selected ticket vanished from list — clearing selection", selectedTicket.id);
      setSelectedTicket(null);
    }
  }

  // Short polling so status/owner changes an admin makes show up here
  // without the user having to hit refresh. See AdminTicketingView for the
  // matching admin-side poll and why this isn't a WebSocket.
  useEffect(() => {
    log("ticketing", `polling every ${POLL_INTERVAL_MS}ms`, { watching: selectedTicket?.id ?? "(list only)" });
    const interval = window.setInterval(() => {
      log("ticketing", "poll tick");
      refreshTickets().catch((err: Error) => logError("ticketing", "poll refresh failed", err));
      if (selectedTicket) {
        getTicket(selectedTicket.id)
          .then((result) => setSelectedTicket(result.ticket))
          .catch((err: Error) => logError("ticketing", "poll ticket reload failed", selectedTicket.id, err));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      log("ticketing", "stopping poll");
      window.clearInterval(interval);
    };
  }, [selectedTicket?.id]);

  async function openTicket(id: string) {
    log("ticketing", "opening ticket", id);
    setUnreadIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const result = await getTicket(id);
    log("ticketing", "ticket loaded", {
      id: result.ticket.id,
      stage: result.ticket.stage,
      comments: result.ticket.comments.length,
    });
    setSelectedTicket(result.ticket);
    setTicketIdInUrl(id);
  }

  async function handleCreated(ticket: TicketDetail) {
    log("ticketing", "ticket created", { id: ticket.id, title: ticket.title, stage: ticket.stage });
    setIsCreateOpen(false);
    setSelectedTicket(ticket);
    setTicketIdInUrl(ticket.id);
    await refreshTickets();
  }

  function closeModal() {
    log("ticketing", "closing new-ticket modal");
    setIsModalClosing(true);
    window.setTimeout(() => {
      setIsCreateOpen(false);
      setIsModalClosing(false);
    }, 210);
  }

  const activeTickets = useMemo(() => tickets.filter((t) => !isDone(t)), [tickets]);
  const doneTickets = useMemo(() => tickets.filter(isDone), [tickets]);

  return (
    <>
      <header className="topbar">
        <h1>My Tickets</h1>
        <button
          className="primary"
          onClick={() => {
            log("ticketing", "opening new-ticket modal", { requestTypes: requestTypes.length });
            setIsCreateOpen(true);
          }}
        >
          <Plus size={18} aria-hidden="true" /> New
        </button>
      </header>

      <div className="workspace-grid">
        <div className="ticket-column">
          <section className="ticket-list-panel" aria-label="Tickets">
            <div className="ticket-list">
              {activeTickets.map((ticket) => (
                <button
                  className={selectedTicket?.id === ticket.id ? "ticket-row selected" : "ticket-row"}
                  key={ticket.id}
                  onClick={() => openTicket(ticket.id).catch((err: Error) => onError(err.message))}
                >
                  {unreadIds.has(ticket.id) && <span className="update-dot" aria-label="Updated" />}
                  <span className="badge-row">
                    <span className={stageClass(ticket.stage)}>{ticket.stage}</span>
                    <span className={priorityClass(ticket.priority)}>{ticket.priority}</span>
                  </span>
                  <strong>{ticket.title}</strong>
                  <small>{ticket.id}</small>
                </button>
              ))}
              {activeTickets.length === 0 && <div className="empty-state">No tickets yet.</div>}
            </div>
          </section>

          {doneTickets.length > 0 && (
            <details className="ticket-list-panel done-panel" aria-label="Done tickets">
              <summary>Done</summary>
              <div className="ticket-list">
                {doneTickets.map((ticket) => (
                  <button
                    className={selectedTicket?.id === ticket.id ? "ticket-row selected" : "ticket-row"}
                    key={ticket.id}
                    onClick={() => openTicket(ticket.id).catch((err: Error) => onError(err.message))}
                  >
                    {unreadIds.has(ticket.id) && <span className="update-dot" aria-label="Updated" />}
                    <span className={stageClass(ticket.stage)}>{ticket.stage}</span>
                    <strong>{ticket.title}</strong>
                    <small>{ticket.id}</small>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="content-column">
          <section className="detail-panel" aria-label="Ticket detail">
            {selectedTicket ? (
              <TicketDetailView
                key={selectedTicket.id}
                onCommentAdded={() => openTicket(selectedTicket.id)}
                ticket={selectedTicket}
              />
            ) : (
              <div className="empty-state">Select a ticket.</div>
            )}
          </section>
        </div>
      </div>

      {isCreateOpen && (
        <div className={`modal-backdrop${isModalClosing ? " closing" : ""}`} role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-ticket-title">
            <div className="modal-heading">
              <h2 id="create-ticket-title">New ticket</h2>
              <button className="icon-button" aria-label="Close new request" onClick={closeModal}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <CreateTicketView requestTypes={requestTypes} onCreated={handleCreated} />
          </section>
        </div>
      )}
    </>
  );
}

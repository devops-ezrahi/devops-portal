import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getRequestTypes, getTicket, listTickets } from "./api";
import { CreateTicketView } from "./components/CreateTicketView";
import { TicketDetailView } from "./components/TicketDetailView";
import { getTicketIdFromUrl, isDone, setTicketIdInUrl, stageClass } from "./utils";
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
    Promise.all([getRequestTypes(), listTickets({ scope: "mine" })])
      .then(([catalog, result]) => {
        setRequestTypes(catalog.requestTypes);
        markChangedSinceLastSeen(result.tickets);
        setTickets(result.tickets);
      })
      .catch((err: Error) => onError(err.message));
    const deepLinkedId = getTicketIdFromUrl();
    if (deepLinkedId) {
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
    markChangedSinceLastSeen(result.tickets);
    setTickets(result.tickets);
    if (selectedTicket && !result.tickets.some((t) => t.id === selectedTicket.id)) {
      setSelectedTicket(null);
    }
  }

  // Short polling so status/owner changes an admin makes show up here
  // without the user having to hit refresh. See AdminTicketingView for the
  // matching admin-side poll and why this isn't a WebSocket.
  useEffect(() => {
    const interval = window.setInterval(() => {
      refreshTickets().catch(() => undefined);
      if (selectedTicket) {
        getTicket(selectedTicket.id)
          .then((result) => setSelectedTicket(result.ticket))
          .catch(() => undefined);
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [selectedTicket?.id]);

  async function openTicket(id: string) {
    setUnreadIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const result = await getTicket(id);
    setSelectedTicket(result.ticket);
    setTicketIdInUrl(id);
  }

  async function handleCreated(ticket: TicketDetail) {
    setIsCreateOpen(false);
    setSelectedTicket(ticket);
    setTicketIdInUrl(ticket.id);
    await refreshTickets();
  }

  function closeModal() {
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
        <button className="primary" onClick={() => setIsCreateOpen(true)}>
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
                  <span className={stageClass(ticket.stage)}>{ticket.stage}</span>
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

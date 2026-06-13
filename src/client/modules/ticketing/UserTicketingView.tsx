import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getRequestTypes, getTicket, listTickets } from "./api";
import { CreateTicketView } from "./components/CreateTicketView";
import { TicketDetailView } from "./components/TicketDetailView";
import { isDone, stageClass } from "./utils";
import type { RequestTypeDefinition, TicketDetail, TicketSummary } from "../../../server/types";

export function UserTicketingView({ onError }: { onError: (message: string) => void }) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<TicketDetail | null>(null);
  const [requestTypes, setRequestTypes] = useState<RequestTypeDefinition[]>([]);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isModalClosing, setIsModalClosing] = useState(false);

  useEffect(() => {
    Promise.all([getRequestTypes(), listTickets({ scope: "mine" })])
      .then(([catalog, result]) => {
        setRequestTypes(catalog.requestTypes);
        setTickets(result.tickets);
      })
      .catch((err: Error) => onError(err.message));
  }, []);

  async function refreshTickets() {
    const result = await listTickets({ scope: "mine" });
    setTickets(result.tickets);
    if (selectedTicket && !result.tickets.some((t) => t.id === selectedTicket.id)) {
      setSelectedTicket(null);
    }
  }

  async function openTicket(id: string) {
    setUnreadIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const result = await getTicket(id);
    setSelectedTicket(result.ticket);
  }

  async function handleCreated(ticket: TicketDetail) {
    setIsCreateOpen(false);
    setSelectedTicket(ticket);
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
        <h1>Tasks</h1>
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
              {activeTickets.length === 0 && <div className="empty-state">No tasks.</div>}
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
          <section className="detail-panel" aria-label="Task detail">
            {selectedTicket ? (
              <TicketDetailView
                key={selectedTicket.id}
                onCommentAdded={() => openTicket(selectedTicket.id)}
                ticket={selectedTicket}
              />
            ) : (
              <div className="empty-state">Select a task.</div>
            )}
          </section>
        </div>
      </div>

      {isCreateOpen && (
        <div className={`modal-backdrop${isModalClosing ? " closing" : ""}`} role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-ticket-title">
            <div className="modal-heading">
              <h2 id="create-ticket-title">New</h2>
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

import { useEffect, useMemo, useState } from "react";
import {
  addAdminComment,
  getAdminTicket,
  listAdminTickets,
  updateAdminTicket
} from "./api";
import { AdminTicketDetail } from "./components/AdminTicketDetail";
import { devopsAdmins } from "./config";
import { isDone, stageClass, statusMessage } from "./utils";
import type { PortalUser, TicketDetail, TicketSummary } from "../../../server/types";

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
      className={isSelected ? "ticket-row selected" : "ticket-row"}
      onClick={() => onOpen(ticket.id)}
    >
      {isUnread && <span className="update-dot" aria-label="Updated" />}
      <span className={stageClass(ticket.stage)}>{ticket.stage}</span>
      <strong>{ticket.title}</strong>
      <div className="ticket-row-meta">
        <small>{ticket.id}</small>
        {ticket.assigneeId
          ? <small className="ticket-row-assignee assigned">{devopsAdmins.find((a) => a.id === ticket.assigneeId)?.name}</small>
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
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    listAdminTickets({})
      .then((result) => setAdminTickets(result.tickets))
      .catch((err: Error) => onError(err.message));
  }, []);

  async function refreshAdminTickets() {
    const result = await listAdminTickets({});
    setAdminTickets(result.tickets);
    if (selectedAdminTicket && !result.tickets.some((t) => t.id === selectedAdminTicket.id)) {
      setSelectedAdminTicket(null);
    }
  }

  async function openAdminTicket(id: string) {
    setUnreadIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const result = await getAdminTicket(id);
    setSelectedAdminTicket(result.ticket);
  }

  async function reloadAdminTicket(id: string) {
    const result = await getAdminTicket(id);
    setSelectedAdminTicket(result.ticket);
    await refreshAdminTickets();
  }

  const currentAdminEntry = devopsAdmins.find((a) => a.name === user.displayName);
  const filteredTickets = useMemo(() => {
    if (showAll) return adminTickets;
    return adminTickets.filter((t) => !t.assigneeId || (currentAdminEntry && t.assigneeId === currentAdminEntry.id));
  }, [adminTickets, showAll, currentAdminEntry?.id]);

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
          <button className="ghost-button" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Mine & Unassigned" : "All tickets"}
          </button>
        </div>
        <section className="ticket-list-panel" aria-label="Admin tickets">
          <div className="ticket-list">
            {activeTickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} isSelected={selectedAdminTicket?.id === ticket.id} isUnread={unreadIds.has(ticket.id)} onOpen={handleOpenTicket} />)}
            {activeTickets.length === 0 && <div className="empty-state">No tasks.</div>}
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

      <section className="detail-panel" aria-label="Task detail">
        {selectedAdminTicket ? (
          <AdminTicketDetail
            key={selectedAdminTicket.id}
            assignee={selectedAdminTicket.assigneeId}
            currentUserName={user.displayName}
            onAssigneeChange={async (assignee) => {
              const ownerName = devopsAdmins.find((a) => a.id === assignee)?.name ?? "Unassigned";
              await updateAdminTicket(selectedAdminTicket.id, { assigneeId: assignee });
              await addAdminComment(selectedAdminTicket.id, statusMessage(`Owner changed to ${ownerName}.`));
              await reloadAdminTicket(selectedAdminTicket.id);
            }}
            onReload={() => reloadAdminTicket(selectedAdminTicket.id)}
            onUpdated={() => setUnreadIds((current) => new Set(current).add(selectedAdminTicket.id))}
            ticket={selectedAdminTicket}
          />
        ) : (
          <div className="empty-state">Select a task.</div>
        )}
      </section>
    </div>
  );
}

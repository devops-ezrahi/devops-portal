import type { AiConversation } from "../../../../server/types";

/**
 * Same two-panel shape ticketing uses for open vs done tickets: the live list in
 * a `ticket-list-panel`, the rest folded into a `details.done-panel`. Archiving
 * is automatic (the server's idle sweep sets `archivedAt`) — reopening one and
 * asking again clears the flag, so there is nothing to click here.
 */
export function ConversationList({
  conversations,
  activeId,
  onSwitchTo,
}: {
  conversations: AiConversation[];
  activeId: string | null;
  onSwitchTo: (id: string) => void;
}) {
  const active = conversations.filter((c) => !c.archivedAt);
  const archived = conversations.filter((c) => c.archivedAt);

  const row = (c: AiConversation) => (
    <button
      key={c.id}
      className={`ticket-row${c.id === activeId ? " selected" : ""}`}
      onClick={() => onSwitchTo(c.id)}
      title={c.title || "New chat"}
    >
      {/* The project is on the meta line already — repeating it as the title too
          just reads as the same word twice on a chat with no question yet. */}
      <strong>{c.title || "New chat"}</strong>
      <small>
        {c.project ?? "auto"} · {c.id}
      </small>
    </button>
  );

  return (
    <>
      <section className="ticket-list-panel" aria-label="Chats">
        <div className="ticket-list">
          {active.length === 0 && <div className="empty-state">No chats yet.</div>}
          {active.map(row)}
        </div>
      </section>

      {archived.length > 0 && (
        <details className="ticket-list-panel done-panel" aria-label="Archived chats">
          <summary>Archived</summary>
          <div className="ticket-list">{archived.map(row)}</div>
        </details>
      )}
    </>
  );
}

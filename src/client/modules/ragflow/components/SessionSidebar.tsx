import { Plus, Trash2 } from "lucide-react";
import type { ChatSession } from "../../../../server/types";

export function SessionSidebar({
  sessions,
  activeId,
  onNewChat,
  onSwitchTo,
  onDeleteSession,
}: {
  sessions: ChatSession[];
  activeId: string | null;
  onNewChat: () => void;
  onSwitchTo: (id: string) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
}) {
  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <button className="chat-new-btn" onClick={onNewChat}>
          <Plus size={14} aria-hidden="true" />
          New chat
        </button>
      </div>
      <div className="chat-sidebar-list">
        {sessions.length === 0 && (
          <div className="chat-sidebar-empty">No chats yet</div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`chat-sidebar-item${s.id === activeId ? " active" : ""}`}
            onClick={() => onSwitchTo(s.id)}
            title={s.title}
          >
            <span className="chat-sidebar-title">{s.title}</span>
            <span
              className="chat-sidebar-delete"
              role="button"
              aria-label="Delete chat"
              onClick={(e) => onDeleteSession(s.id, e)}
            >
              <Trash2 size={13} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

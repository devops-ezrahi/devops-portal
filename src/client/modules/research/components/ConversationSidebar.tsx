import { Plus } from "lucide-react";
import type { ResearchConversation } from "../../../../server/types";

export function ConversationSidebar({
  conversations,
  activeId,
  onNewChat,
  onSwitchTo,
}: {
  conversations: ResearchConversation[];
  activeId: string | null;
  onNewChat: () => void;
  onSwitchTo: (id: string) => void;
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
        {conversations.length === 0 && <div className="chat-sidebar-empty">No chats yet</div>}
        {conversations.map((c) => (
          <button
            key={c.id}
            className={`chat-sidebar-item${c.id === activeId ? " active" : ""}`}
            onClick={() => onSwitchTo(c.id)}
            title={c.title || c.project}
          >
            <span className="chat-sidebar-title">{c.title || c.project}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

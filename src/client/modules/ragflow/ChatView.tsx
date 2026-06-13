import { MessageSquare, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { getPortalConfig } from "../../api";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ChatMessage, ChatSession } from "../../../server/types";
import { streamChat } from "./api";

const SESSIONS_KEY = "chat:sessions";
const ACTIVE_KEY = "chat:activeId";

function loadSessions(): ChatSession[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]") as ChatSession[];
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

function saveActiveId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New chat";
  return first.content.length > 42 ? first.content.slice(0, 42) + "…" : first.content;
}

function createSession(): ChatSession {
  const now = Date.now();
  return { id: makeId(), title: "New chat", messages: [], createdAt: now, updatedAt: now };
}

export function ChatView({ refreshKey, onError }: ModuleViewProps) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const saved = loadActiveId();
    const all = loadSessions();
    return all.find((s) => s.id === saved) ? saved : (all[0]?.id ?? null);
  });
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [chatEnabled, setChatEnabled] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef(false);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const messages = activeSession?.messages ?? [];

  useEffect(() => {
    getPortalConfig().then((cfg) => setChatEnabled(cfg.chatEnabled ?? false));
  }, []);

  useEffect(() => {
    abortRef.current = true;
    setInput("");
    setIsStreaming(false);
  }, [refreshKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function updateSession(id: string, patch: Partial<ChatSession>) {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s));
      saveSessions(next);
      return next;
    });
  }

  function switchTo(id: string) {
    abortRef.current = true;
    setIsStreaming(false);
    setInput("");
    setActiveId(id);
    saveActiveId(id);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function newChat() {
    const session = createSession();
    setSessions((prev) => {
      const next = [session, ...prev];
      saveSessions(next);
      return next;
    });
    switchTo(session.id);
  }

  function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveSessions(next);
      return next;
    });
    if (activeId === id) {
      const remaining = sessions.filter((s) => s.id !== id);
      const nextId = remaining[0]?.id ?? null;
      setActiveId(nextId);
      saveActiveId(nextId);
    }
  }

  function adjustTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || isStreaming) return;

    let targetId = activeId;
    if (!targetId) {
      const session = createSession();
      setSessions((prev) => {
        const next = [session, ...prev];
        saveSessions(next);
        return next;
      });
      targetId = session.id;
      setActiveId(targetId);
      saveActiveId(targetId);
    }

    const currentMessages = sessions.find((s) => s.id === targetId)?.messages ?? [];
    const withUser: ChatMessage[] = [...currentMessages, { role: "user", content: text }];
    const withAssistant: ChatMessage[] = [...withUser, { role: "assistant", content: "" }];

    updateSession(targetId, {
      messages: withAssistant,
      title: deriveTitle(withUser),
    });

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsStreaming(true);
    abortRef.current = false;

    try {
      for await (const chunk of streamChat(withUser)) {
        if (abortRef.current) break;
        setSessions((prev) => {
          const next = prev.map((s) => {
            if (s.id !== targetId) return s;
            const msgs = s.messages;
            const last = msgs[msgs.length - 1];
            if (last?.role !== "assistant") return s;
            return {
              ...s,
              messages: [...msgs.slice(0, -1), { ...last, content: last.content + chunk }],
              updatedAt: Date.now(),
            };
          });
          saveSessions(next);
          return next;
        });
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Chat failed");
      setSessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== targetId) return s;
          const msgs = s.messages;
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant" && last.content === "") {
            return { ...s, messages: msgs.slice(0, -1), updatedAt: Date.now() };
          }
          return s;
        });
        saveSessions(next);
        return next;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  if (chatEnabled === null) {
    return <div className="loading-state" aria-label="Loading" />;
  }

  if (!chatEnabled) {
    return (
      <div className="chat-module">
        <div className="chat-not-configured">
          <MessageSquare size={40} style={{ opacity: 0.25 }} aria-hidden="true" />
          <p style={{ margin: 0, fontWeight: 700, color: "#c8d3d7" }}>AI Assistant not configured</p>
          <p style={{ margin: 0, fontSize: 13, maxWidth: 420 }}>
            Configure either RAGFlow (<code>RAGFLOW_API_URL</code> + <code>RAGFLOW_API_KEY</code> +{" "}
            <code>RAGFLOW_CHAT_ID</code>) or any OpenAI-compatible API (
            <code>OPENAI_API_URL</code> + <code>OPENAI_API_KEY</code>).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-module">
      <div className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button className="chat-new-btn" onClick={newChat}>
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
              onClick={() => switchTo(s.id)}
              title={s.title}
            >
              <span className="chat-sidebar-title">{s.title}</span>
              <span
                className="chat-sidebar-delete"
                role="button"
                aria-label="Delete chat"
                onClick={(e) => deleteSession(s.id, e)}
              >
                <Trash2 size={13} />
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <MessageSquare size={17} style={{ color: "#20c7bd" }} aria-hidden="true" />
            <h2 style={{ margin: 0, fontSize: 15 }}>
              {activeSession?.title ?? "AI Assistant"}
            </h2>
          </div>
        </div>

        <div className="chat-messages">
          {messages.length === 0 && (
            <div className="chat-empty">
              <MessageSquare size={40} style={{ opacity: 0.18 }} aria-hidden="true" />
              <p style={{ margin: 0, fontWeight: 700, color: "#c8d3d7" }}>Ask anything</p>
              <p style={{ margin: 0, fontSize: 13, maxWidth: 360 }}>
                Connected to your team's knowledge base. Ask about processes, runbooks, or how to
                get things done.
              </p>
            </div>
          )}

          {messages.map((msg, i) => {
            const isLastAssistant = msg.role === "assistant" && i === messages.length - 1 && isStreaming;
            return (
              <div
                key={i}
                className={`chat-msg ${msg.role === "user" ? "chat-msg-user" : "chat-msg-assistant"}`}
              >
                {msg.role === "user" ? (
                  msg.content
                ) : (
                  <>
                    {msg.content === "" && isLastAssistant ? (
                      <span className="chat-typing" aria-label="Thinking">
                        <span /><span /><span />
                      </span>
                    ) : (
                      <div className="chat-md">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                        >
                          {msg.content || " "}
                        </ReactMarkdown>
                      </div>
                    )}
                    {isLastAssistant && msg.content !== "" && (
                      <span className="chat-cursor" aria-hidden="true" />
                    )}
                  </>
                )}
              </div>
            );
          })}

          <div ref={bottomRef} />
        </div>

        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustTextarea(); }}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question… (Enter to send, Shift+Enter for new line)"
            rows={1}
            disabled={isStreaming}
          />
          <button
            className="chat-send-btn"
            onClick={() => void sendMessage()}
            disabled={!input.trim() || isStreaming}
            aria-label="Send message"
          >
            <Send size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

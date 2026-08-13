import { Send, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getPortalConfig } from "../../api";
import { log, warn, error as logError } from "../../log";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ChatMessage, AiCategory, AiConversation, AiJob } from "../../../server/types";
import {
  cancelJob,
  createConversation,
  fetchCategories,
  fetchConversationJobs,
  fetchConversations,
  pollJob,
  submitQuestion,
} from "./api";
import { CategoryPicker } from "./components/CategoryPicker";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { MessageList } from "./components/MessageList";

const POLL_MS = 2000;

function isPending(status: AiJob["status"]) {
  return status === "pending" || status === "in-progress";
}

function jobToMessages(job: AiJob): ChatMessage[] {
  const answer =
    job.status === "failed" ? `⚠️ ${job.errorMessage ?? "Failed"}` :
    job.status === "aborted" ? "_Stopped._" :
    (job.answer ?? "");
  // Rendered as a blockquote so it reads as opencode's own tool trace, not
  // part of the answer — markdown blockquotes need no extra rendering setup.
  const thinking = job.thinking ? job.thinking.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n" : "";
  return [
    { role: "user", content: job.question },
    { role: "assistant", content: thinking + answer },
  ];
}

export function AiView({ refreshKey, onError }: ModuleViewProps) {
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [categories, setCategories] = useState<AiCategory[]>([]);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Derived, not stored: "is something running right now" is a fact about the
  // jobs we already hold. The previous version tracked it in state alongside a
  // one-shot polling loop guarded by a shared ref — switching conversations set
  // that ref and permanently killed the in-flight poll, so a finished answer
  // never landed until a manual refresh.
  const pendingJob = jobs.find((j) => isPending(j.status)) ?? null;

  useEffect(() => {
    log("ai", "view mounted");
    getPortalConfig().then((cfg) => {
      if (!cfg.aiEnabled) warn("ai", "disabled — no ai-* skills or OPENCODE_API_KEY not set");
      setAiEnabled(cfg.aiEnabled ?? false);
    });
    fetchCategories()
      .then(setCategories)
      .catch((err) => logError("ai", "failed to load categories", err));
    fetchConversations()
      .then((list) => {
        setConversations(list);
        if (list[0]) selectConversation(list[0].id);
      })
      .catch((err) => logError("ai", "failed to load conversations", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setInput("");
  }, [refreshKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [jobs]);

  // Poll while the visible conversation has a job in flight. Runs off derived
  // state, so it self-heals: switching away and back, or reloading a
  // conversation whose job is still running, resumes polling instead of
  // stranding the answer until a manual refresh.
  useEffect(() => {
    if (!pendingJob) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      let job: AiJob;
      try {
        job = await pollJob(pendingJob.id);
      } catch (err) {
        logError("ai", "poll failed", { jobId: pendingJob.id }, err);
        onError(err instanceof Error ? err.message : "Failed to check job status");
        clearInterval(timer);
        return;
      }
      if (cancelled) return;
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
      if (!isPending(job.status)) {
        // Re-fetch rather than patch in place: an "I'm not sure" conversation's
        // `project` only resolves server-side once this turn's classification
        // step runs, so a partial local patch would miss it.
        fetchConversations()
          .then(setConversations)
          .catch((err) => logError("ai", "failed to refresh conversations", err));
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingJob?.id, onError]);

  function selectConversation(id: string) {
    setActiveConversationId(id);
    fetchConversationJobs(id)
      .then(setJobs)
      .catch((err) => logError("ai", "failed to load conversation jobs", err));
  }

  async function pickCategory(project: string | null) {
    try {
      const conversation = await createConversation(project);
      log("ai", "conversation started", { id: conversation.id, project });
      setConversations((prev) => [conversation, ...prev]);
      setJobs([]);
      setActiveConversationId(conversation.id);
      setShowPicker(false);
    } catch (err) {
      logError("ai", "failed to start conversation", err);
      onError(err instanceof Error ? err.message : "Failed to start chat");
    }
  }

  function adjustTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }

  async function sendMessage() {
    const question = input.trim();
    if (!question || !activeConversationId || pendingJob) {
      log("ai", "send ignored", { empty: !question, activeConversationId, pending: pendingJob?.id });
      return;
    }

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      const job = await submitQuestion(activeConversationId, question);
      log("ai", "job submitted", { id: job.id, conversationId: activeConversationId });
      setJobs((prev) => [...prev, job]);
    } catch (err) {
      logError("ai", "submit failed", err);
      onError(err instanceof Error ? err.message : "Failed to submit question");
    }
  }

  async function stopActiveJob() {
    if (!pendingJob) return;
    try {
      const job = await cancelJob(pendingJob.id);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
    } catch (err) {
      logError("ai", "cancel failed", err);
      onError(err instanceof Error ? err.message : "Failed to stop job");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  if (aiEnabled === null) {
    return <div className="loading-state" aria-label="Loading" />;
  }

  if (!aiEnabled) {
    return (
      <div className="chat-module">
        <div className="chat-not-configured">
          <Sparkles size={40} style={{ opacity: 0.25 }} aria-hidden="true" />
          <p style={{ margin: 0, fontWeight: 700, color: "#c8d3d7" }}>AI not configured</p>
          <p style={{ margin: 0, fontSize: 13, maxWidth: 420 }}>
            Add a <code>ai-*</code> skill under <code>AI_SKILLS_DIR</code> and set{" "}
            <code>OPENCODE_API_KEY</code> (optionally <code>OPENCODE_MODEL</code>) — see{" "}
            <code>.env.example</code>.
          </p>
        </div>
      </div>
    );
  }

  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? null;
  const messages = jobs.flatMap(jobToMessages);

  return (
    <div className="chat-module">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeConversationId}
        onNewChat={() => setShowPicker(true)}
        onSwitchTo={selectConversation}
      />

      {showPicker && (
        <CategoryPicker categories={categories} onPick={(p) => void pickCategory(p)} onClose={() => setShowPicker(false)} />
      )}

      <div className="chat-main">
        <div className="chat-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={17} style={{ color: "#20c7bd" }} aria-hidden="true" />
            <h2 style={{ margin: 0, fontSize: 15 }}>
              {activeConversation ? activeConversation.title || activeConversation.project || "New chat" : "AI"}
            </h2>
          </div>
        </div>

        {!activeConversationId ? (
          <div className="chat-empty">
            <Sparkles size={40} style={{ opacity: 0.18 }} aria-hidden="true" />
            <p style={{ margin: 0, fontWeight: 700, color: "#c8d3d7" }}>Start a new chat</p>
            <p style={{ margin: 0, fontSize: 13, maxWidth: 360 }}>
              Pick what it's about — the repo stays fixed for the rest of that chat.
            </p>
          </div>
        ) : (
          <MessageList messages={messages} isPending={!!pendingJob} bottomRef={bottomRef} />
        )}

        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustTextarea(); }}
            onKeyDown={handleKeyDown}
            placeholder={
              !activeConversation
                ? "Start a new chat to ask a question"
                : activeConversation.project
                  ? `Ask about ${activeConversation.project}… (Enter to send, Shift+Enter for new line)`
                  : "Ask your question — I'll figure out which repo fits"
            }
            rows={1}
            disabled={!!pendingJob || !activeConversationId}
          />
          {pendingJob ? (
            <button className="chat-send-btn" onClick={() => void stopActiveJob()} aria-label="Stop">
              <Square size={17} aria-hidden="true" />
            </button>
          ) : (
            <button
              className="chat-send-btn"
              onClick={() => void sendMessage()}
              disabled={!input.trim() || !activeConversationId}
              aria-label="Send message"
            >
              <Send size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

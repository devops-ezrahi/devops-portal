import { Search, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getPortalConfig } from "../../api";
import { log, warn, error as logError } from "../../log";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ChatMessage, ResearchJob } from "../../../server/types";
import { cancelJob, fetchJobs, fetchProjects, pollJob, submitQuestion } from "./api";
import { MessageList } from "./components/MessageList";

const POLL_MS = 2000;

function isPending(status: ResearchJob["status"]) {
  return status === "pending" || status === "in-progress";
}

function jobToMessages(job: ResearchJob): ChatMessage[] {
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

export function ResearchView({ refreshKey, onError }: ModuleViewProps) {
  const [researchEnabled, setResearchEnabled] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [input, setInput] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stopPollingRef = useRef(false);

  useEffect(() => {
    log("research", "view mounted");
    getPortalConfig().then((cfg) => {
      if (!cfg.researchEnabled) warn("research", "disabled — RESEARCH_PROJECTS/OPENCODE_API_KEY not set on the server");
      setResearchEnabled(cfg.researchEnabled ?? false);
    });
    fetchProjects()
      .then((names) => {
        setProjects(names);
        setProject((prev) => prev || names[0] || "");
      })
      .catch((err) => logError("research", "failed to load projects", err));
    fetchJobs()
      .then((history) => setJobs(history.slice().reverse()))
      .catch((err) => logError("research", "failed to load job history", err));
  }, []);

  useEffect(() => {
    log("research", "refresh — stopping any poll in flight", { refreshKey });
    stopPollingRef.current = true;
    setActiveJobId(null);
    setInput("");
  }, [refreshKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [jobs]);

  function adjustTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }

  async function pollUntilDone(jobId: string) {
    while (!stopPollingRef.current) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (stopPollingRef.current) return;
      let job: ResearchJob;
      try {
        job = await pollJob(jobId);
      } catch (err) {
        logError("research", "poll failed", { jobId }, err);
        onError(err instanceof Error ? err.message : "Failed to check job status");
        return;
      }
      setJobs((prev) => prev.map((j) => (j.id === jobId ? job : j)));
      if (!isPending(job.status)) {
        setActiveJobId(null);
        return;
      }
    }
  }

  async function sendMessage() {
    const question = input.trim();
    if (!question || !project || activeJobId) {
      log("research", "send ignored", { empty: !question, project, activeJobId });
      return;
    }

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    stopPollingRef.current = false;

    try {
      const job = await submitQuestion(project, question);
      log("research", "job submitted", { id: job.id, project });
      setJobs((prev) => [job, ...prev]);
      setActiveJobId(job.id);
      void pollUntilDone(job.id);
    } catch (err) {
      logError("research", "submit failed", err);
      onError(err instanceof Error ? err.message : "Failed to submit question");
    }
  }

  async function stopActiveJob() {
    if (!activeJobId) return;
    try {
      const job = await cancelJob(activeJobId);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
    } catch (err) {
      logError("research", "cancel failed", err);
      onError(err instanceof Error ? err.message : "Failed to stop job");
    } finally {
      setActiveJobId(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  if (researchEnabled === null) {
    return <div className="loading-state" aria-label="Loading" />;
  }

  if (!researchEnabled) {
    return (
      <div className="chat-module">
        <div className="chat-not-configured">
          <Search size={40} style={{ opacity: 0.25 }} aria-hidden="true" />
          <p style={{ margin: 0, fontWeight: 700, color: "#c8d3d7" }}>Research not configured</p>
          <p style={{ margin: 0, fontSize: 13, maxWidth: 420 }}>
            Set <code>RESEARCH_PROJECTS</code> + <code>OPENCODE_API_KEY</code> (and optionally{" "}
            <code>OPENCODE_MODEL</code>) — see <code>.env.example</code>.
          </p>
        </div>
      </div>
    );
  }

  const messages = jobs.slice().reverse().flatMap(jobToMessages);

  return (
    <div className="chat-module">
      <div className="chat-main">
        <div className="chat-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Search size={17} style={{ color: "#20c7bd" }} aria-hidden="true" />
            <h2 style={{ margin: 0, fontSize: 15 }}>Research</h2>
          </div>
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            disabled={!!activeJobId || projects.length === 0}
            aria-label="Project to research"
          >
            {projects.length === 0 && <option value="">No projects configured</option>}
            {projects.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <MessageList messages={messages} isPending={!!activeJobId} bottomRef={bottomRef} />

        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustTextarea(); }}
            onKeyDown={handleKeyDown}
            placeholder={project ? `Ask about ${project}… (Enter to send, Shift+Enter for new line)` : "No project selected"}
            rows={1}
            disabled={!!activeJobId || !project}
          />
          {activeJobId ? (
            <button className="chat-send-btn" onClick={() => void stopActiveJob()} aria-label="Stop">
              <Square size={17} aria-hidden="true" />
            </button>
          ) : (
            <button
              className="chat-send-btn"
              onClick={() => void sendMessage()}
              disabled={!input.trim() || !project}
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

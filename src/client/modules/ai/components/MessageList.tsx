import { Sparkles } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
// rehype-highlight only tags the code with .hljs-* classes — without a theme
// they are unstyled, which is what shipped. styles.css already assumes this
// one (it neutralises the background it injects).
import "highlight.js/styles/atom-one-dark.css";
import type { ChatMessage } from "../../../../server/types";

/** After this long, the bare dots stop being reassuring — say what's happening. */
const EXPLAIN_AFTER_MS = 10_000;

function ThinkingIndicator() {
  const [explain, setExplain] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setExplain(true), EXPLAIN_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <span className="chat-typing" aria-label="Thinking">
        <span /><span /><span />
      </span>
      {explain && (
        <p className="chat-thinking-note">
          Still working — it's opening and reading the actual files in the repo so the answer is
          grounded in the real code, not a guess. Bigger questions take longer.
        </p>
      )}
    </>
  );
}

export function MessageList({
  messages,
  isPending,
  bottomRef,
}: {
  messages: ChatMessage[];
  isPending: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="chat-messages">
      {messages.length === 0 && (
        <div className="empty-state">
          <Sparkles size={40} className="empty-icon" aria-hidden="true" />
          <strong>Ask anything about this repo</strong>
          <p className="field-hint">It pulls the latest code and reads the real files to answer.</p>
        </div>
      )}

      {messages.map((msg, i) => {
        const isLastAssistant = msg.role === "assistant" && i === messages.length - 1 && isPending;
        // While pending, `content` still holds the streamed tool trace — show it
        // alongside the dots rather than hiding progress behind them.
        const hasTrace = isLastAssistant && msg.content.trim().length > 0;
        return (
          <div
            key={i}
            className={`chat-msg ${msg.role === "user" ? "chat-msg-user" : "chat-msg-assistant"}`}
          >
            {msg.role === "user" ? (
              msg.content
            ) : (
              <>
                {(hasTrace || !isLastAssistant) && (
                  <div className="chat-md">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                    >
                      {msg.content || " "}
                    </ReactMarkdown>
                  </div>
                )}
                {isLastAssistant && <ThinkingIndicator />}
              </>
            )}
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}

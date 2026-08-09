import { Search } from "lucide-react";
import type { RefObject } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../../../../server/types";

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
        <div className="chat-empty">
          <Search size={40} style={{ opacity: 0.18 }} aria-hidden="true" />
          <p style={{ margin: 0, fontWeight: 700, color: "#c8d3d7" }}>Pick a project and ask</p>
          <p style={{ margin: 0, fontSize: 13, maxWidth: 360 }}>
            The server clones the repo (once) and reads it via opencode to answer your question.
          </p>
        </div>
      )}

      {messages.map((msg, i) => {
        const isLastAssistant = msg.role === "assistant" && i === messages.length - 1 && isPending;
        return (
          <div
            key={i}
            className={`chat-msg ${msg.role === "user" ? "chat-msg-user" : "chat-msg-assistant"}`}
          >
            {msg.role === "user" ? (
              msg.content
            ) : isLastAssistant ? (
              <span className="chat-typing" aria-label="Researching">
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
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}

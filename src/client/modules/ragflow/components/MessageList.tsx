import { MessageSquare } from "lucide-react";
import type { RefObject } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../../../../server/types";

export function MessageList({
  messages,
  isStreaming,
  bottomRef,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
}) {
  return (
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
  );
}

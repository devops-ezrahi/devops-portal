import { LinkedText } from "./LinkedText";
import { OutgoingComments, useOutbox } from "./Outbox";
import { MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { log, error as logError } from "../../../log";
import { addComment } from "../api";
import type { TicketDetail } from "../../../../server/types";
import { priorityResponseHours } from "../config";
import { formatDate, isStatusMessage, priorityClass, statusMessageText, stageClass } from "../utils";

export function TicketDetailView({
  onCommentAdded,
  ticket
}: {
  onCommentAdded: () => Promise<void>;
  ticket: TicketDetail;
}) {
  const [body, setBody] = useState("");
  const outbox = useOutbox();

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    const text = body;
    setBody("");
    log("ticketing", "posting comment", { ticket: ticket.id, chars: text.length });
    await outbox
      .post(text, (t) => addComment(ticket.id, t), onCommentAdded, (t) => setBody((current) => current || t))
      .then(() => log("ticketing", "comment posted", ticket.id))
      .catch((err) => logError("ticketing", "addComment failed", ticket.id, err));
  }

  return (
    <article className="ticket-detail">
      <div className="detail-heading">
        <div className="badge-row">
          <span className={stageClass(ticket.stage)}>{ticket.stage}</span>
          <span className={priorityClass(ticket.priority)} title={`Response within ${priorityResponseHours[ticket.priority]} hours`}>
            {ticket.priority}
          </span>
          {ticket.url ? (
          <a className="detail-id" href={ticket.url} target="_blank" rel="noreferrer" title="Open in Jira">
            {ticket.id}
          </a>
        ) : (
          <span className="detail-id">{ticket.id}</span>
        )}
        </div>
        <h2>{ticket.title}</h2>
      </div>

      {/* A create that succeeded but did less than it was asked to. Not a
          failure — the ticket is right there — so it reads as a warning, the
          same shape an Artifactory job's dependencyFallback uses. */}
      {ticket.notice && <div className="warn-banner">{ticket.notice}</div>}

      <p className="description-text"><LinkedText text={ticket.description} /></p>

      <section>
        <h3 className="field-label">
          Messages {outbox.error && <span className="save-state failed" role="alert">{outbox.error}</span>}
        </h3>
        <div className="comments">
          {ticket.comments.map((comment) =>
            isStatusMessage(comment.body) ? (
              <div className="status-row" key={comment.id}>
                <span>{statusMessageText(comment.body)}</span>
                <small>{formatDate(comment.createdAt)}</small>
              </div>
            ) : (
              <div className="comment" key={comment.id}>
                <strong dir="auto">{comment.authorName}</strong>
                <small>{formatDate(comment.createdAt)}</small>
                <p><LinkedText text={comment.body} /></p>
              </div>
            )
          )}
          <OutgoingComments items={outbox.items} author="You" />
          {ticket.comments.length === 0 && outbox.items.length === 0 && <div className="empty-state">No messages.</div>}
        </div>
        <form className="comment-form" onSubmit={submitComment}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message" required />
          <button className="primary" disabled={!body.trim()}>
            <MessageSquarePlus size={18} aria-hidden="true" /> Send
          </button>
        </form>
      </section>
    </article>
  );
}

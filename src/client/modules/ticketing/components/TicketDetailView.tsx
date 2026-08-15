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
  const [submitting, setSubmitting] = useState(false);

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    log("ticketing", "posting comment", { ticket: ticket.id, chars: body.length });
    try {
      await addComment(ticket.id, body);
      log("ticketing", "comment posted", ticket.id);
      setBody("");
      await onCommentAdded();
    } catch (err) {
      logError("ticketing", "addComment failed", ticket.id, err);
      throw err;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="ticket-detail">
      <div className="detail-heading">
        <div className="badge-row">
          <span className={stageClass(ticket.stage)}>{ticket.stage}</span>
          <span className={priorityClass(ticket.priority)} title={`Response within ${priorityResponseHours[ticket.priority]} hours`}>
            {ticket.priority}
          </span>
          <span className="detail-id">{ticket.id}</span>
        </div>
        <h2>{ticket.title}</h2>
      </div>

      <p className="description-text">{ticket.description}</p>

      <section>
        <h3>Messages</h3>
        <div className="comments">
          {ticket.comments.map((comment) =>
            isStatusMessage(comment.body) ? (
              <div className="status-row" key={comment.id}>
                <span>{statusMessageText(comment.body)}</span>
                <small>{formatDate(comment.createdAt)}</small>
              </div>
            ) : (
              <div className="comment" key={comment.id}>
                <strong>{comment.authorName}</strong>
                <small>{formatDate(comment.createdAt)}</small>
                <p>{comment.body}</p>
              </div>
            )
          )}
          {ticket.comments.length === 0 && <div className="empty-state">No messages.</div>}
        </div>
        <form className="comment-form" onSubmit={submitComment}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message" required />
          <button className="primary" disabled={submitting || !body.trim()}>
            <MessageSquarePlus size={18} aria-hidden="true" /> Send
          </button>
        </form>
      </section>
    </article>
  );
}

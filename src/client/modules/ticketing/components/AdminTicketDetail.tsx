import { Check, MessageSquarePlus, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { addAdminComment, updateAdminTicket } from "../api";
import { stages } from "../config";
import type { CustomerStage, TicketDetail } from "../../../../server/types";
import { formatDate, isStatusMessage, statusMessage, statusMessageText, stageClass } from "../utils";

export function AdminTicketDetail({
  assignee,
  currentUserId,
  onAssigneeChange,
  onReload,
  onUpdated,
  ticket
}: {
  assignee: string;
  currentUserId: string;
  onAssigneeChange: (assignee: string) => Promise<void>;
  onReload: () => Promise<void>;
  onUpdated: () => void;
  ticket: TicketDetail;
}) {
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [stage, setStage] = useState<CustomerStage>(ticket.stage);
  const [rawStatus, setRawStatus] = useState(ticket.rawStatus);
  const [teamGroups, setTeamGroups] = useState(ticket.teamGroups.join(", "));
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  function autoResizeDescription(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  useEffect(() => {
    if (isEditing && descriptionRef.current) {
      autoResizeDescription(descriptionRef.current);
    }
  }, [isEditing]);

  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description);
    setStage(ticket.stage);
    setRawStatus(ticket.rawStatus);
    setTeamGroups(ticket.teamGroups.join(", "));
    setBody("");
    setIsEditing(false);
  }, [ticket.id]);

  async function saveStage(newStage: CustomerStage) {
    if (newStage === ticket.stage) return;
    setSubmitting(true);
    try {
      await updateAdminTicket(ticket.id, {
        title,
        stage: newStage,
        rawStatus,
        description,
        teamGroups: teamGroups.split(",").map((g) => g.trim()).filter(Boolean)
      });
      await addAdminComment(ticket.id, statusMessage(`Stage changed to ${newStage}.`));
      await onReload();
      onUpdated();
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdits() {
    setIsEditing(false);
    const titleChanged = title !== ticket.title;
    const descriptionChanged = description !== ticket.description;
    if (!titleChanged && !descriptionChanged) return;
    setSubmitting(true);
    try {
      await updateAdminTicket(ticket.id, {
        title,
        stage,
        rawStatus,
        description,
        teamGroups: teamGroups.split(",").map((g) => g.trim()).filter(Boolean)
      });
      if (titleChanged) {
        await addAdminComment(ticket.id, statusMessage(`Title changed to "${title}".`));
      }
      if (descriptionChanged) {
        await addAdminComment(ticket.id, statusMessage("Description updated."));
      }
      await onReload();
      onUpdated();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitResponse(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await addAdminComment(ticket.id, body);
      setBody("");
      await onReload();
      onUpdated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="ticket-detail">
      <span className={stageClass(ticket.stage)}>{ticket.stage}</span>

      <div className="detail-title-row">
        {isEditing ? (
          <input
            className="title-edit-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
            autoFocus
          />
        ) : (
          <h2>{title}</h2>
        )}
        <button
          className="icon-button edit-toggle"
          type="button"
          aria-label={isEditing ? "Done editing" : "Edit title and description"}
          onClick={() => (isEditing ? saveEdits().catch(() => undefined) : setIsEditing(true))}
          disabled={submitting}
        >
          {isEditing ? <Check size={16} aria-hidden="true" /> : <Pencil size={16} aria-hidden="true" />}
        </button>
      </div>

      {isEditing ? (
        <textarea
          ref={descriptionRef}
          className="description-edit-textarea"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            autoResizeDescription(e.currentTarget);
          }}
          disabled={submitting}
        />
      ) : (
        <p className="description-text">{description}</p>
      )}

      <div className="detail-heading">
        <div>
          <p>{ticket.id}</p>
        </div>
        <label className="owner-select">
          <span>Owner</span>
          <div className="owner-controls">
            <input
              type="text"
              value={assignee}
              placeholder="Unassigned"
              onChange={(e) => onAssigneeChange(e.target.value).catch(() => undefined)}
            />
            <button
              className="ghost-button"
              type="button"
              onClick={() => onAssigneeChange(currentUserId).catch(() => undefined)}
            >
              Me
            </button>
          </div>
        </label>
      </div>

      <div className="admin-edit-form">
        <label>
          <span>Stage</span>
          <select
            value={stage}
            onChange={(e) => {
              const newStage = e.target.value as CustomerStage;
              setStage(newStage);
              saveStage(newStage).catch(() => undefined);
            }}
            disabled={submitting}
          >
            {stages.filter(Boolean).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

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
        <form className="comment-form" onSubmit={submitResponse}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message"
            required
          />
          <button className="primary" disabled={submitting || !body.trim()}>
            <MessageSquarePlus size={18} aria-hidden="true" /> Send
          </button>
        </form>
      </section>
    </article>
  );
}

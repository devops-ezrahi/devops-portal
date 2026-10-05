import { Pop } from "../../../Pop";
import { LinkedText } from "./LinkedText";
import { Spinner } from "../../../Spinner";
import { OutgoingComments, useOutbox } from "./Outbox";
import { Check, ChevronDown, ChevronUp, MessageSquarePlus, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { log, error as logError } from "../../../log";
import { addAdminComment, updateAdminTicket } from "../api";
import { priorityResponseHours, stages } from "../config";
import type { AssigneeCandidate, CustomerStage, TicketDetail } from "../../../../server/types";
import { formatDate, isStatusMessage, priorityClass, statusMessage, statusMessageText, stageClass } from "../utils";

export function AdminTicketDetail({
  assignee,
  assignees,
  currentUserId,
  currentUserName,
  onAssigneeChange,
  onReload,
  onStagePreview,
  ticket
}: {
  assignee: string;
  assignees: AssigneeCandidate[];
  currentUserId: string;
  currentUserName: string;
  onAssigneeChange: (assigneeId: string, assigneeName: string) => Promise<void>;
  onReload: () => Promise<void>;
  /** Shows a stage in the queue row before the server has confirmed it. */
  onStagePreview: (stage: CustomerStage) => void;
  ticket: TicketDetail;
}) {
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [stage, setStage] = useState<CustomerStage>(ticket.stage);
  const [storyPoints, setStoryPoints] = useState(ticket.storyPoints?.toString() ?? "");
  const [rawStatus, setRawStatus] = useState(ticket.rawStatus);
  const [teamGroups, setTeamGroups] = useState(ticket.teamGroups.join(", "));
  const [body, setBody] = useState("");
  const [saving, track] = useSaving();
  const outbox = useOutbox();
  const [isEditing, setIsEditing] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const pointsRef = useRef<HTMLInputElement>(null);
  // What the server last accepted, so a refused stage change has somewhere to
  // go back to; `stageQueue` keeps two quick changes in the order they were made.
  const confirmedStage = useRef<CustomerStage>(ticket.stage);
  const stageQueue = useRef<Promise<unknown>>(Promise.resolve());

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
    confirmedStage.current = ticket.stage;
    setStoryPoints(ticket.storyPoints?.toString() ?? "");
    setRawStatus(ticket.rawStatus);
    setTeamGroups(ticket.teamGroups.join(", "));
    setBody("");
    setIsEditing(false);
  }, [ticket.id]);

  const parsedPoints = storyPoints.trim() === "" ? undefined : Number(storyPoints);
  const hasPoints = parsedPoints !== undefined && Number.isFinite(parsedPoints) && parsedPoints >= 0;
  const groups = () => teamGroups.split(",").map((g) => g.trim()).filter(Boolean);

  function step(by: number) {
    setStoryPoints(String(Math.max(0, (Number(storyPoints) || 0) + by)));
    // Stepping leaves the field focused, so the same blur that saves a typed
    // value saves a stepped one — one request per edit, not per click.
    pointsRef.current?.focus();
  }

  async function savePoints() {
    if (parsedPoints === ticket.storyPoints) return;
    if (!hasPoints) return log("ticketing/admin", "story points not a non-negative number — not saving", storyPoints);
    log("ticketing/admin", "saving story points", ticket.id, parsedPoints);
    await track("points", async () => {
      try {
        await updateAdminTicket(ticket.id, { storyPoints: parsedPoints });
      } catch (err) {
        logError("ticketing/admin", "saving story points failed", ticket.id, err);
        setStoryPoints(ticket.storyPoints?.toString() ?? "");
        throw err;
      }
      await onReload();
    });
  }

  /**
   * Optimistic: the select and both badges show the new stage the moment it is
   * picked, and nothing is locked while it saves — a Jira round trip is a
   * second or two, and freezing the whole form for it read as the page hanging.
   * A refusal puts the last accepted stage back and says why beside the field.
   */
  function changeStage(newStage: CustomerStage) {
    setStage(newStage);
    onStagePreview(newStage);
    const run = () =>
      track("stage", async () => {
        if (newStage === confirmedStage.current) return log("ticketing/admin", "stage unchanged — skipping save", newStage);
        log("ticketing/admin", "changing stage", ticket.id, `${confirmedStage.current} → ${newStage}`);
        try {
          await updateAdminTicket(ticket.id, {
            title,
            stage: newStage,
            storyPoints: parsedPoints,
            rawStatus,
            description,
            teamGroups: groups()
          });
        } catch (err) {
          logError("ticketing/admin", "stage change failed", ticket.id, err);
          setStage(confirmedStage.current);
          onStagePreview(confirmedStage.current);
          throw err;
        }
        confirmedStage.current = newStage;
        await addAdminComment(ticket.id, statusMessage(`Stage changed to ${newStage}.`));
        log("ticketing/admin", "stage saved", ticket.id, newStage);
        await onReload();
      });
    stageQueue.current = stageQueue.current.then(run).catch(() => undefined);
  }

  async function saveEdits() {
    setIsEditing(false);
    const titleChanged = title !== ticket.title;
    const descriptionChanged = description !== ticket.description;
    if (!titleChanged && !descriptionChanged) return log("ticketing/admin", "no edits to save", ticket.id);
    log("ticketing/admin", "saving edits", ticket.id, { titleChanged, descriptionChanged });
    await track("edits", async () => {
      try {
        await updateAdminTicket(ticket.id, { title, stage, rawStatus, description, teamGroups: groups() });
      } catch (err) {
        logError("ticketing/admin", "saving edits failed", ticket.id, err);
        throw err;
      }
      if (titleChanged) await addAdminComment(ticket.id, statusMessage(`Title changed to "${title}".`));
      if (descriptionChanged) await addAdminComment(ticket.id, statusMessage("Description updated."));
      log("ticketing/admin", "edits saved", ticket.id);
      await onReload();
    });
  }

  async function submitResponse(event: FormEvent) {
    event.preventDefault();
    // The box empties at once, so the next message can be typed while this one
    // is on its way.
    const text = body;
    setBody("");
    log("ticketing/admin", "posting response", { ticket: ticket.id, chars: text.length });
    await outbox
      .post(text, (t) => addAdminComment(ticket.id, t), onReload, (t) => setBody((current) => current || t))
      .then(() => log("ticketing/admin", "response posted", ticket.id))
      .catch((err) => logError("ticketing/admin", "addAdminComment failed", ticket.id, err));
  }

  return (
    <article className="ticket-detail">
      <div className="badge-row">
        <Pop value={stage} className={stageClass(stage)}>{stage}</Pop>
        <Pop value={ticket.priority} className={priorityClass(ticket.priority)} title={`Response within ${priorityResponseHours[ticket.priority]} hours`}>
          {ticket.priority}
        </Pop>
        {ticket.url ? (
          <a className="detail-id" href={ticket.url} target="_blank" rel="noreferrer" title="Open in Jira">
            {ticket.id}
          </a>
        ) : (
          <span className="detail-id">{ticket.id}</span>
        )}
      </div>

      {/* A create that succeeded but did less than it was asked to. Not a
          failure — the ticket is right there — so it reads as a warning, the
          same shape an Artifactory job's dependencyFallback uses. */}
      {ticket.notice && <div className="warn-banner">{ticket.notice}</div>}

      <div className="detail-title-row">
        {isEditing ? (
          <input className="title-edit-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        ) : (
          <h2>{title}</h2>
        )}
        <SaveState state={saving.edits} />
        <button
          className="icon-button edit-toggle"
          type="button"
          aria-label={isEditing ? "Done editing" : "Edit title and description"}
          onClick={() => (isEditing ? saveEdits().catch(() => undefined) : setIsEditing(true))}
          disabled={saving.edits === "saving"}
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
        />
      ) : (
        <p className="description-text"><LinkedText text={description} /></p>
      )}

      <div className="detail-heading">
        <label className="owner-select">
          <span className="field-label">Owner <SaveState state={saving.owner} /></span>
          <div className="owner-select-row">
            <select
              value={assignee}
              onChange={(e) => {
                const id = e.target.value;
                // Falling through to the ticket's own name matters for the
                // stale option below: picking it must not blank out the only
                // name we have for someone missing from the roster.
                const name = assignees.find((a) => a.id === id)?.displayName ?? (id === assignee ? ticket.assigneeName : "");
                track("owner", () => onAssigneeChange(id, name)).catch(() => undefined);
              }}
            >
              <option value="">Unassigned</option>
              {assignee && !assignees.some((a) => a.id === assignee) && (
                // Assigned to someone not in the known-admins roster (e.g. they
                // haven't logged in since the last restart) — keep them selectable
                // instead of silently blanking the dropdown.
                <option value={assignee} dir="auto">
                  {ticket.assigneeName || assignee}
                </option>
              )}
              {assignees.map((a) => (
                <option key={a.id} value={a.id} dir="auto">
                  {a.displayName}
                  {a.id === currentUserId ? " (me)" : ""}
                </option>
              ))}
            </select>
            {assignee !== currentUserId && (
              <button
                type="button"
                className="ghost-button me-button"
                onClick={() => track("owner", () => onAssigneeChange(currentUserId, currentUserName)).catch(() => undefined)}
              >
                Me
              </button>
            )}
          </div>
        </label>
      </div>

      <div className="admin-edit-form">
        <label>
          <span className="field-label">Story points <SaveState state={saving.points} /></span>
          <div className="points-field">
            <input
              ref={pointsRef}
              type="number"
              min={0}
              step="any"
              value={storyPoints}
              placeholder="—"
              onChange={(e) => setStoryPoints(e.target.value)}
              onBlur={() => savePoints().catch(() => undefined)}
            />
            {/* The press must not blur the input: the blur would save the value
                from before the step, and nothing would save the one after it. */}
            <div className="points-step" onMouseDown={(e) => e.preventDefault()}>
              <button type="button" aria-label="Increase story points" onClick={() => step(1)}>
                <ChevronUp size={13} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Decrease story points" onClick={() => step(-1)}>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
        </label>
        <label>
          <span className="field-label">Stage <SaveState state={saving.stage} /></span>
          <select value={stage} onChange={(e) => changeStage(e.target.value as CustomerStage)}>
            {stages.filter(Boolean).map((option) => (
              // Closing signs off the work, so it stays unselectable until an
              // estimate exists. The server rejects it too — see router.ts.
              <option key={option} value={option} disabled={option === "Closed" && !hasPoints}>
                {option}
                {option === "Closed" && !hasPoints ? " (needs story points)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section>
        <h3 className="field-label">Messages {outbox.error && <SaveState state={outbox.error} />}</h3>
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
          <OutgoingComments items={outbox.items} author={currentUserName} />
          {ticket.comments.length === 0 && outbox.items.length === 0 && <div className="empty-state">No messages.</div>}
        </div>
        <form className="comment-form" onSubmit={submitResponse}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message"
            required
          />
          <button className="primary" disabled={!body.trim()}>
            <MessageSquarePlus size={18} aria-hidden="true" /> Send
          </button>
        </form>
      </section>
    </article>
  );
}

type Field = "stage" | "points" | "edits" | "owner";
/** `"saving"`, `"saved"` (for a moment), or the refusal's message. */
type FieldState = string | undefined;

/**
 * One save state per field, so a save in flight locks nothing else on the
 * form. Counts calls per field: with two queued, the first finishing must not
 * say the field is saved while the second is still on its way.
 */
function useSaving() {
  const [states, setStates] = useState<Partial<Record<Field, FieldState>>>({});
  const inflight = useRef<Partial<Record<Field, number>>>({});
  const set = (field: Field, state: FieldState) => setStates((s) => ({ ...s, [field]: state }));
  async function track(field: Field, work: () => Promise<void>) {
    inflight.current[field] = (inflight.current[field] ?? 0) + 1;
    set(field, "saving");
    try {
      await work();
    } catch (err) {
      inflight.current[field]! -= 1;
      set(field, `Not saved — ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    if ((inflight.current[field]! -= 1) > 0) return;
    set(field, "saved");
    window.setTimeout(() => setStates((s) => (s[field] === "saved" ? { ...s, [field]: undefined } : s)), 1600);
  }
  return [states, track] as const;
}

// ponytail: one element across all three states, so Saving… → Saved pops on
// the node that was already there (the first "Saving…" just fades in).
function SaveState({ state }: { state: FieldState }) {
  if (!state) return null;
  const kind = state === "saving" || state === "saved" ? state : "failed";
  return (
    <Pop
      value={kind}
      className={kind === "saving" ? "save-state" : `save-state ${kind}`}
      role={kind === "failed" ? "alert" : "status"}
    >
      {kind === "saving" ? <><Spinner size={12} /> Saving…</> : kind === "saved" ? <><Check size={12} aria-hidden="true" /> Saved</> : state}
    </Pop>
  );
}

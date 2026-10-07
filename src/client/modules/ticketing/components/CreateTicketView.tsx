import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { log, warn, error as logError } from "../../../log";
import { createTicket } from "../api";
import { defaultPriority, priorities, priorityResponseHours } from "../config";
import type { RequestTypeDefinition, TicketDetail, TicketPriority } from "../../../../server/types";

export function CreateTicketView({
  requestTypes,
  onCreated
}: {
  requestTypes: RequestTypeDefinition[];
  onCreated: (ticket: TicketDetail) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TicketPriority>(defaultPriority);
  const [submitting, setSubmitting] = useState(false);
  const selected = requestTypes[0];

  useEffect(() => {
    setTitle("");
    setDescription("");
    setPriority(defaultPriority);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return warn("ticketing/create", "no request type available — nothing submitted");
    const fields = { title, description };
    setSubmitting(true);
    log("ticketing/create", "submitting", { requestType: selected.id, priority, fields });
    try {
      const result = await createTicket({
        requestType: selected.id,
        priority,
        fields,
        // ponytail: crypto.randomUUID() requires a secure context (https/localhost);
        // this portal runs on plain http://*.homelab.local, so it's undefined there.
        // getRandomValues has no such restriction.
        idempotencyKey: crypto.randomUUID?.() ?? crypto.getRandomValues(new Uint32Array(4)).join("-")
      });
      log("ticketing/create", "created", result.ticket.id, result.ticket.stage);
      await onCreated(result.ticket);
    } catch (err) {
      logError("ticketing/create", "createTicket failed", err);
      throw err;
    } finally {
      setSubmitting(false);
    }
  }

  // Ctrl+Enter (Cmd+Enter on a Mac) sends from any field — Enter alone stays a
  // newline in the description. requestSubmit runs the same validation a click
  // on Submit does, so an empty name still stops it.
  function submitOnCtrlEnter(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || submitting) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }

  return (
    <div className="create-grid">
      {selected && (
        <form className="request-form" onSubmit={submit} onKeyDown={submitOnCtrlEnter}>
          <label>
            <span>Ticket name</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label>
            <span>Description <small className="field-hint">optional</small></span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>
            <span>Priority</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TicketPriority)}
              disabled={submitting}
            >
              {priorities.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <small className="field-hint">Response within {priorityResponseHours[priority]} hours</small>
          </label>
          <button className="primary" disabled={submitting} title="Submit (Ctrl+Enter)">
            <Send size={18} aria-hidden="true" /> Submit
          </button>
        </form>
      )}
    </div>
  );
}

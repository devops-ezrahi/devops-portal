import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createTicket } from "../api";
import type { RequestTypeDefinition, TicketDetail } from "../../../../server/types";

export function CreateTicketView({
  requestTypes,
  onCreated
}: {
  requestTypes: RequestTypeDefinition[];
  onCreated: (ticket: TicketDetail) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selected = requestTypes[0];

  useEffect(() => {
    setTitle("");
    setDescription("");
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const fields = Object.fromEntries(
      selected.fields.map((field) => {
        if (field.name === "title") return [field.name, title];
        if (field.name === "description") return [field.name, description];
        return [field.name, field.options?.[0] ?? title];
      })
    );
    setSubmitting(true);
    try {
      const result = await createTicket({
        requestType: selected.id,
        fields,
        idempotencyKey: crypto.randomUUID()
      });
      await onCreated(result.ticket);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="create-grid">
      {selected && (
        <form className="request-form" onSubmit={submit}>
          <label>
            <span>Name</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label>
            <span>Description</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} required />
          </label>
          <button className="primary" disabled={submitting}>
            <Send size={18} aria-hidden="true" /> Submit
          </button>
        </form>
      )}
    </div>
  );
}

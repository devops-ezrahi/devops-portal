import { X } from "lucide-react";
import { useState } from "react";
import { log } from "../../../log";
import { CreateTicketView } from "./CreateTicketView";
import type { RequestTypeDefinition, TicketDetail } from "../../../../server/types";

export function NewTicketModal({
  requestTypes,
  onClose,
  onCreated
}: {
  requestTypes: RequestTypeDefinition[];
  onClose: () => void;
  onCreated: (ticket: TicketDetail) => Promise<void>;
}) {
  const [closing, setClosing] = useState(false);

  function close() {
    log("ticketing", "closing new-ticket modal");
    setClosing(true);
    window.setTimeout(onClose, 210);
  }

  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-ticket-title">
        <div className="modal-heading">
          <h2 id="create-ticket-title">New ticket</h2>
          <button className="icon-button" aria-label="Close new request" onClick={close}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <CreateTicketView requestTypes={requestTypes} onCreated={onCreated} />
      </section>
    </div>
  );
}

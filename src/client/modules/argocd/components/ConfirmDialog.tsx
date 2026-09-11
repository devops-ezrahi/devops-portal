import { TriangleAlert } from "lucide-react";

/**
 * "This holds values — really delete it?"
 *
 * Only ever shown for something that would actually lose work: an empty
 * namespace or microservice is removed the moment its × is pressed. So this is
 * not a habit anyone clicks through, which is the only way a confirmation is
 * worth having at all.
 *
 * Not `window.confirm`: that one is unstyled, unskippable by keyboard
 * convention, and blocks the whole tab. It is the portal's own `.modal`, the
 * same shape `NewTreeDialog` and `ImportDialog` use.
 */
export function ConfirmDialog({
  title,
  detail,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  title: string;
  /** What is lost — say it in full, because the × gave no warning of its own. */
  detail: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal ag-confirm" role="dialog" aria-modal="true" aria-labelledby="ag-confirm-title">
        <div className="modal-heading">
          <h2 id="ag-confirm-title">{title}</h2>
        </div>
        <p className="ag-confirm-detail">
          <TriangleAlert size={15} aria-hidden="true" /> {detail}
        </p>
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" autoFocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

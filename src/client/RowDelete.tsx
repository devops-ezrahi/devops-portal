import { X } from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent } from "react";

/**
 * The small × a list row shows on hover. It sits inside the row's own button,
 * so it is a `span role="button"` that stops the press reaching the row — a
 * sibling element would break the rows' `:nth-child` entrance delays.
 *
 * Two presses: the first turns it into "Delete?", the second deletes. Leaving
 * the row disarms it. A one-press × at the edge of a row you are about to click
 * is a deleted job waiting to happen, and a modal is too much for a list row.
 */
export function RowDelete({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);

  function press(e: MouseEvent | KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (armed) onDelete();
    else setArmed(true);
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={`row-delete${armed ? " armed" : ""}`}
      aria-label={armed ? `Confirm deleting ${label}` : `Delete ${label}`}
      title={armed ? "Press again to delete" : "Delete"}
      onClick={press}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") press(e);
      }}
      onMouseLeave={() => setArmed(false)}
      onBlur={() => setArmed(false)}
    >
      {armed ? "Delete?" : <X size={14} aria-hidden="true" />}
    </span>
  );
}

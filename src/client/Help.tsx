import { HelpCircle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/**
 * The `?` that holds an explanation until it is wanted.
 *
 * The portal's forms had grown a sentence under every control — true sentences,
 * but forty-five of them stacked up read as a wall to scroll past rather than
 * as help, and the thing you came to change was somewhere behind it. So the
 * text moves in here and the page keeps the label.
 *
 * It opens on hover, and also on click and on focus. Hover alone would be
 * unreachable by touch and invisible to a keyboard; click alone is what the
 * Jenkinsfile builder's own `?` does today and it costs a press for something
 * you only want to glance at. All three, and it works everywhere.
 *
 * Still a button rather than a `title=` tooltip, for the reason the Jenkinsfile
 * one gives: a native tooltip cannot be opened by touch and vanishes while you
 * are reading it.
 */
export function Help({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="help" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="help-toggle"
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // These two are load-bearing: a `?` often sits inside a <label> whose
          // control is a checkbox, or inside a card that is itself a button.
          // Without them, asking what something is would switch it on.
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <HelpCircle size={13} aria-hidden="true" />
      </button>
      {open && (
        <span className="help-body" id={id} role="tooltip">
          {children}
        </span>
      )}
    </span>
  );
}

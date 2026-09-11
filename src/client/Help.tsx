import { HelpCircle } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

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
export function Help({
  label,
  children,
  trigger,
  interactive,
}: {
  label: string;
  children: ReactNode;
  /** Replaces the `?` glyph — the override light is the same popover on a different button. */
  trigger?: ReactNode;
  /** The popover holds a control, so it has to be reachable with the mouse. */
  interactive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A `?` at the right edge of a wide row — a stage card's header, a group's —
  // would hang its popover off the window, so it anchors to its right instead.
  // 360 is `.help-body`'s own max-width; keep the two in step.
  const [right, setRight] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  function show() {
    const box = wrap.current?.getBoundingClientRect();
    setRight(!!box && box.left + 360 > window.innerWidth);
    setOpen(true);
  }

  return (
    // Focus is handled on the wrapper, not the button: React's onFocus/onBlur
    // are focusin/focusout, so a popover holding a control stays open while
    // focus moves into it instead of closing under the press.
    <span
      ref={wrap}
      className="help"
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onFocus={show}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOpen(false);
      }}
    >
      <button
        type="button"
        className={`help-toggle${interactive ? " interactive" : ""}`}
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          // These two are load-bearing: a `?` often sits inside a <label> whose
          // control is a checkbox, or inside a card that is itself a button.
          // Without them, asking what something is would switch it on.
          e.preventDefault();
          e.stopPropagation();
          if (open) setOpen(false);
          else show();
        }}
      >
        {trigger ?? <HelpCircle size={13} aria-hidden="true" />}
      </button>
      {open && (
        <span
          className={`help-body${interactive ? " interactive" : ""}${right ? " right" : ""}`}
          id={id}
          role="tooltip"
        >
          {children}
        </span>
      )}
    </span>
  );
}

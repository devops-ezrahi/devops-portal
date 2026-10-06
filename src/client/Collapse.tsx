import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A fold that slides instead of jumping.
 *
 * Closed still means unmounted — every caller used to be `{open && …}`, and
 * effects, touch scopes and a heavy FeatureEditor body all rely on that — so
 * the children stay mounted only for the length of the close animation. They
 * mount in the same render `open` turns true, so a jump that opens a fold and
 * scrolls to something inside it still finds it.
 *
 * The slide is `grid-template-rows: 0fr → 1fr`, which animates to the content's
 * real height without measuring it. The inner box clips while moving and stops
 * clipping once open (`settled`), or an image picker or `?` popover inside a
 * stage card would be cut off at the card's edge.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [alive, setAlive] = useState(open);
  const [shown, setShown] = useState(open);
  const [settled, setSettled] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  /** Whether it got as far as opening — a fold closed again before that has nothing to slide shut. */
  const opened = useRef(open);
  if (open && !alive) setAlive(true);

  useEffect(() => {
    if (open && !shown) {
      void ref.current?.offsetHeight; // commit the 0fr start, or there is nothing to transition from
      opened.current = true;
      setShown(true);
    } else if (!open && shown) {
      setShown(false);
      setSettled(false);
      // No transition to wait for (no stylesheet, as in tests): unmount now.
      // A fold closed inside a hidden module never gets its `transitionend`
      // and stays mounted at zero height until it is next opened — harmless.
      const el = ref.current;
      if (!el || !parseFloat(getComputedStyle(el).transitionDuration)) {
        opened.current = false;
        setAlive(false);
      }
    } else if (!open && alive && !opened.current) {
      setAlive(false);
    }
  }, [open, shown, alive]);

  if (!open && !alive) return null;
  return (
    <div
      ref={ref}
      className={`collapse${shown ? " open" : ""}${settled ? " settled" : ""}`}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== "grid-template-rows") return;
        if (open) setSettled(true);
        else {
          opened.current = false;
          setAlive(false);
        }
      }}
    >
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

import { useLayoutEffect, useRef, type HTMLAttributes } from "react";

/** A value compared by `Object.is` — never an object, since a poll hands back fresh ones. */
export type PopValue = string | number | boolean | null | undefined;

/**
 * Two looks, one family: `pop` is a badge taking a new word (Submitted → In
 * Review), `tick` is a number moving — a scale on a count that ticks every
 * second reads as the page throbbing, a 2px lift does not.
 */
const FRAMES: Record<"pop" | "tick", { frames: Keyframe[]; duration: number }> = {
  pop: {
    frames: [
      { transform: "scale(0.85)", opacity: 0.4 },
      { transform: "scale(1.06)", opacity: 1, offset: 0.6 },
      { transform: "scale(1)" },
    ],
    duration: 280,
  },
  tick: {
    frames: [{ transform: "translateY(-3px)", opacity: 0.45 }, { transform: "none", opacity: 1 }],
    duration: 220,
  },
};

const UNSEEN = Symbol("unseen");

/**
 * Plays a brief motion on the element when `value` changes in place, so a
 * change is noticed without reading it. Never on mount — a list of thirty rows
 * landing at once, or the 8s poll re-rendering every one, must stay still —
 * and never on an equal value. WAAPI rather than a remount, so nothing inside
 * loses its DOM state, which also means the CSS reduced-motion rule cannot
 * reach it: the media query is checked here, as `flip.tsx` does.
 *
 * Pass a value that changes because something *happened* (a status, a save, a
 * server count) — never one derived from what is being typed, or it pops per
 * keystroke.
 *
 * `appear` pops on mount as well, for a thing whose arrival *is* the change (a
 * tag showing up on a card that was already there). The caller decides that,
 * since only it knows whether its own first render is under way.
 */
export function usePop<T extends HTMLElement>(value: PopValue, variant: "pop" | "tick" = "pop", appear = false) {
  const ref = useRef<T>(null);
  const last = useRef<PopValue | typeof UNSEEN>(appear ? UNSEEN : value);
  useLayoutEffect(() => {
    if (Object.is(last.current, value)) return;
    last.current = value;
    const el = ref.current;
    if (!el?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const { frames, duration } = FRAMES[variant];
    el.animate(frames, { duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }, [value, variant]);
  return ref;
}

/** A `<span>` that pops when `value` changes. `.pop` makes a bare inline span transformable. */
export function Pop({
  value,
  variant,
  appear,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { value: PopValue; variant?: "pop" | "tick"; appear?: boolean }) {
  const ref = usePop<HTMLSpanElement>(value, variant, appear);
  return <span ref={ref} className={className ? `${className} pop` : "pop"} {...rest} />;
}

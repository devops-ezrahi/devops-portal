import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from "react";

type Seen = { index: number; x: number; y: number };

/**
 * Glides list items to their new place when the order changes (a sort, a ▲/▼,
 * a new row pushing the rest down) instead of letting them jump — FLIP over
 * the Web Animations API, no library.
 *
 * Items are tracked by DOM node, which React keeps per key across a reorder,
 * and placed by `offsetLeft/Top`, which neither page scroll nor a running
 * transform moves — so only real layout moves animate. Only an item whose
 * *position in the list* changed moves: a textarea growing above it shifts it
 * too, and gliding every keystroke reads as lag.
 */
export function useFlip(scope: RefObject<HTMLElement | null>, selector: string) {
  const seen = useRef(new WeakMap<HTMLElement, Seen>());
  useLayoutEffect(() => {
    const root = scope.current;
    if (!root) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    root.querySelectorAll<HTMLElement>(selector).forEach((el, index) => {
      const now = { index, x: el.offsetLeft, y: el.offsetTop };
      const was = seen.current.get(el);
      seen.current.set(el, now);
      if (!was || still || was.index === index || !el.animate) return;
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      if (!dx && !dy) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 320,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
    });
  });
}

/** A `<div>` whose direct children glide when reordered — the job/ticket lists. */
export function FlipList(props: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, ":scope > *");
  return <div ref={ref} {...props} />;
}

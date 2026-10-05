import type { ReactNode } from "react";

/**
 * Something is on its way. No spinner: the words fade in only once the wait is
 * long enough to notice (a fast save never flashes anything), then breathe
 * gently until the answer arrives — and the answer is what moves (`Pop`).
 * The delay and the breathing are both CSS (`.pending`), so a wait that ends
 * before 300ms renders exactly nothing anyone can see.
 */
export function Pending({ children }: { children: ReactNode }) {
  return (
    <span className="pending" role="status">
      {children}
    </span>
  );
}

/**
 * Stands in for a list or panel until its first answer arrives. Without it an
 * empty list read "No jobs yet." for the length of the request — a claim, and
 * a wrong one, on every page load and every Refresh.
 */
export function Loading({ what }: { what: string }) {
  return (
    <div className="empty-state loading-row">
      <Pending>Loading {what}…</Pending>
    </div>
  );
}

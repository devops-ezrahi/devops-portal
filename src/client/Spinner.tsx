import { LoaderCircle } from "lucide-react";

/**
 * The portal's one "this is happening" mark — on a button while its request is
 * out, beside a field while it saves. Takes an icon's place rather than sitting
 * next to it, so a busy button keeps its width.
 */
export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

/**
 * Stands in for a list or panel until its first answer arrives. Without it an
 * empty list read "No jobs yet." for the length of the request — a claim, and
 * a wrong one, on every page load and every Refresh.
 */
export function Loading({ what }: { what: string }) {
  return (
    <div className="empty-state loading-row" role="status">
      <Spinner /> Loading {what}…
    </div>
  );
}

import type { ReactNode } from "react";

/**
 * A button's icon that turns into a spinner while its action runs — but only
 * after 400ms, so a fast Pull never flashes one. The delay is a CSS
 * `animation-delay`, not a timer. The spinner sits in the icon's own box, so
 * the button keeps its width; the label's "Pulling…" is the caller's.
 */
export function BusyIcon({ busy, icon }: { busy: boolean; icon: ReactNode }) {
  if (!busy) return <>{icon}</>;
  return (
    <span className="busy-icon" aria-hidden="true">
      {icon}
      <span className="busy-spinner" />
    </span>
  );
}

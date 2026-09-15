import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const KEY = "portalListNarrow";
const CLASS = "list-narrow";

/**
 * Every module's list column has two widths, and this button flips between
 * them. The state is one class on <html> rather than React state, because every
 * module stays mounted while hidden — a per-view flag would leave each module's
 * button showing a different icon for the one shared width. CSS picks the icon.
 */
export function ListSizeToggle() {
  function toggle() {
    const narrow = document.documentElement.classList.toggle(CLASS);
    try {
      localStorage.setItem(KEY, narrow ? "1" : "");
    } catch {
      /* not remembered, still applied */
    }
  }
  return (
    <button type="button" className="list-size-toggle" aria-label="Minimize or maximize the list" title="Minimize / maximize" onClick={toggle}>
      <PanelLeftClose className="when-wide" size={16} aria-hidden="true" />
      <PanelLeftOpen className="when-narrow" size={16} aria-hidden="true" />
    </button>
  );
}

/** Applies the remembered width before the first paint that shows a list. */
export function restoreListSize() {
  try {
    if (localStorage.getItem(KEY)) document.documentElement.classList.add(CLASS);
  } catch {
    /* default width */
  }
}

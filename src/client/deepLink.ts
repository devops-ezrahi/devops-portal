import { useEffect, useRef } from "react";

/**
 * Put the selected row's id in the URL as `/<slug>/<id>`, so a job can be sent
 * to someone as a link. The shell's router only ever reads the *first* path
 * segment (`moduleFromPath` in App.tsx), so a second one costs it nothing.
 */
function firstSegment(): string {
  return window.location.pathname.replace(/^\//, "").split("/")[0].toLowerCase();
}

/** The id in the current URL, or `null` when it names another module or no row. */
export function idFromPath(slug: string): string | null {
  const [first, second] = window.location.pathname.replace(/^\//, "").split("/");
  return first?.toLowerCase() === slug && second ? decodeURIComponent(second) : null;
}

export function useDeepLink(slug: string, selectedId: string | null, onSelect: (id: string | null) => void) {
  // Deliberately keyed on `selectedId` alone: modules stay mounted when hidden,
  // so an effect that ran on every render would have the background module
  // shove its own path back over the one the nav just pushed.
  useEffect(() => {
    const path = selectedId ? `/${slug}/${encodeURIComponent(selectedId)}` : `/${slug}`;
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  }, [slug, selectedId]);

  // Back/Forward. A pop into another module carries no id of ours — acting on
  // it would clear the selection sitting behind the tab you just left.
  const select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    const onPop = () => {
      if (firstSegment() === slug) select.current(idFromPath(slug));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [slug]);
}

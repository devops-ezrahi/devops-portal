import { useEffect, useRef, useState, type RefObject } from "react";
import { log, error as logError } from "./log";

/**
 * "The repository moved since you pulled" for the two git-connected builders —
 * the ticket views' poll, pointed at a branch instead of the ticket list.
 *
 * Each check is one `POST /api/<module>/remote`, which costs the server a
 * `git ls-remote` and nothing else unless the branch head actually moved, so a
 * 30s interval is cheap. It is still slower than the ticket poll's 8s: a git
 * host is somebody else's server, and nobody merges twice a minute.
 */
export const REMOTE_CHECK_MS = 30_000;
/** A tab coming back into view checks at once — but not on every alt-tab. */
const FOCUS_MIN_GAP_MS = 5_000;

export type RemoteTarget = { repoUrl: string; revision: string; path: string };

/**
 * The object id `path` has on the remote branch now, or `""` until the first
 * answer. Compared against the `sha` the last pull stored, by the caller.
 *
 * Paused while the browser tab is hidden or `anchor` sits under a `hidden`
 * element (a module the nav has switched away from stays mounted inside a
 * `hidden` slot, and must not keep asking).
 */
export function useRemoteSha(
  target: RemoteTarget | null,
  check: (repoUrl: string, revision: string, path: string) => Promise<{ sha: string }>,
  anchor: RefObject<HTMLElement | null>
): string {
  const [remote, setRemote] = useState("");
  const checkRef = useRef(check);
  checkRef.current = check;
  const repoUrl = target?.repoUrl.trim() ?? "";
  const revision = target?.revision.trim() ?? "";
  const path = target?.path.trim() ?? "";

  useEffect(() => {
    setRemote("");
    if (!repoUrl || !revision) return;
    let live = true;
    let last = 0;
    const tick = () => {
      if (document.hidden || anchor.current?.closest("[hidden]")) return;
      last = Date.now();
      checkRef
        .current(repoUrl, revision, path)
        .then((r) => {
          if (!live) return;
          log("remote", "checked", { repoUrl, revision, path, sha: r.sha.slice(0, 10) });
          setRemote(r.sha);
        })
        // A failed check says nothing about the repository — the connection
        // check on the repo panel is what reports an unreadable one.
        .catch((err: unknown) => logError("remote", "check failed", err));
    };
    const onFocus = () => {
      if (Date.now() - last > FOCUS_MIN_GAP_MS) tick();
    };
    // Not immediately: the connection fields are text, and the first check
    // waits out typing the way the connection's own read does.
    const first = setTimeout(tick, 1500);
    const timer = setInterval(tick, REMOTE_CHECK_MS);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [repoUrl, revision, path, anchor]);

  return remote;
}

/** Whether a connection edit points somewhere else, so the `sha` the last pull stored no longer describes it. */
export const retargeted = (a: RemoteTarget, b: RemoteTarget) =>
  a.repoUrl.trim() !== b.repoUrl.trim() || a.revision.trim() !== b.revision.trim() || a.path.trim() !== b.path.trim();

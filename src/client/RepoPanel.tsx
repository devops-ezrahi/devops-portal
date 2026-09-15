import {
  ChevronDown,
  ChevronRight,
  CloudDownload,
  ExternalLink,
  GitBranch,
  GitPullRequestArrow,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Where a builder's document comes from and where it goes back to — shared by
 * the Jenkinsfile and ArgoCD modules, so the two have one idea of what
 * connecting a repository looks like. The bar names the repo and carries Pull;
 * unfolding it shows the fields, so the connection can be changed mid-edit.
 * Commit is not here: it sits on the preview, beside the files it writes.
 */

export type PushState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; branch: string; prUrl: string; changed: boolean; note?: string }
  | { kind: "error"; message: string };

/** A git URL as the name people call it: the last path segment, without `.git`. */
export const repoName = (url: string): string =>
  url.trim().replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || "not set";

export function CommitButton({
  blocked,
  saved,
  push,
  onCommit,
  what,
}: {
  /** Why git cannot be reached, or "" — said on the button rather than found by pressing it. */
  blocked: string;
  /** A push writes the *stored* document, so an unsaved one has nothing to push. */
  saved: boolean;
  push: PushState;
  onCommit: () => void;
  /** "tree" / "pipeline", for the tooltip. */
  what: string;
}) {
  return (
    <button
      type="button"
      className="primary"
      disabled={!!blocked || !saved || push.kind === "busy"}
      title={blocked || (!saved ? `Saving — the commit writes the saved ${what}` : "Commit and open a pull request")}
      onClick={onCommit}
    >
      <GitPullRequestArrow size={16} aria-hidden="true" /> {push.kind === "busy" ? "Committing…" : "Commit"}
    </button>
  );
}

/** What the last commit did, under the files it wrote. */
export function PushResult({ push, what }: { push: PushState; what: string }) {
  if (push.kind === "error")
    return (
      <p className="git-push-result error">
        <TriangleAlert size={14} aria-hidden="true" /> {push.message}
      </p>
    );
  if (push.kind !== "done") return null;
  return (
    <p className={`git-push-result${push.changed ? "" : " quiet"}`}>
      {push.changed ? (
        <>
          Committed to <code>{push.branch}</code>.{" "}
          {push.prUrl ? (
            <a href={push.prUrl} target="_blank" rel="noreferrer">
              Open the pull request <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : (
            push.note
          )}
        </>
      ) : (
        <>The repository already matches this {what} — nothing to commit.</>
      )}
    </p>
  );
}

type Props = {
  /** The uppercase label naming the repo's role ("Values", "Repo"). */
  role: string;
  repoUrl: string;
  revision: string;
  /** A path inside the repo worth showing on the collapsed bar. */
  sub?: string;
  blocked: string;
  /** Why the repository could not be read — shown above the fields, where it can be fixed. */
  error?: string;
  onPull: () => void;
  pulling: boolean;
  /** What a pull would replace ("the 3 stages in this pipeline"), or "" when nothing. */
  replaces: string;
  /** The editable fields, shown when unfolded. */
  children: ReactNode;
};

export function RepoPanel({ role, repoUrl, revision, sub, blocked, error, onPull, pulling, replaces, children }: Props) {
  const [open, setOpen] = useState(false);
  /**
   * A pull replaces what is in the builder, so the first press on a document
   * that holds something asks. The portal's own confirm rather than
   * `window.confirm`: a browser dialog looks like it came from somewhere else.
   */
  const [confirming, setConfirming] = useState(false);

  // Unconnected and folded: a bar reading "not set @main" beside a disabled
  // Pull says nothing useful, so the whole bar is one offer to connect.
  if (!repoUrl.trim() && !open)
    return (
      <div className="git-repo-panel git-repo-empty">
        <button type="button" className="ghost-button git-repo-connect" onClick={() => setOpen(true)}>
          <GitBranch size={14} aria-hidden="true" /> Connect repo
        </button>
      </div>
    );

  return (
    <div className="git-repo-panel">
      {error && (
        <p className="git-push-result error">
          <TriangleAlert size={14} aria-hidden="true" /> Could not read the repository: {error}
        </p>
      )}
      <div className="git-repo-bar">
        <button type="button" className="git-repo-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span className="git-repo-summary">
            <span className="git-repo-role">{role}</span>
            {repoUrl.trim() && (
              <span className="git-repo-ref">
                {repoName(repoUrl)}
                <span className="git-repo-rev">@{revision || "?"}</span>
              </span>
            )}
            {sub && <span className="git-repo-sub">{sub}</span>}
          </span>
        </button>

        <div className="git-repo-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={!!blocked || pulling}
            title={blocked || "Re-read the repository and replace what is here with what is in it"}
            onClick={() => {
              if (replaces && !confirming) setConfirming(true);
              else {
                setConfirming(false);
                onPull();
              }
            }}
          >
            <CloudDownload size={16} aria-hidden="true" /> {pulling ? "Pulling…" : confirming ? "Pull anyway" : "Pull"}
          </button>
        </div>
      </div>

      {confirming && (
        <p className="git-push-result warn">
          <TriangleAlert size={14} aria-hidden="true" /> Pulling replaces {replaces} with whatever is in the repository.
        </p>
      )}

      {open && <div className="git-repo">{children}</div>}
    </div>
  );
}

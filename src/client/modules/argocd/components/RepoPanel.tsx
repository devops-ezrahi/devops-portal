import { ChevronDown, ChevronRight, CloudDownload, ExternalLink, GitPullRequestArrow, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { isSshUrl, normalizeRepoUrl } from "../../../../server/gitUrl";
import { Help } from "../../../Help";
import type { DraftTree } from "../document";

/**
 * Where this tree comes from and where it goes back to.
 *
 * The values repo used to be half of a "Repositories" disclosure, sharing
 * billing with the chart. They are not comparable: the chart is a deployment
 * fact that is set once and read forever, while the values repo is this tree's
 * destination — the thing a commit writes to and the thing ArgoCD watches. So
 * the values repo is the panel, with its two buttons on the row that names it,
 * and the chart is one small line underneath (`ChartLine`).
 */

export type PushState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; branch: string; prUrl: string; changed: boolean; note?: string }
  | { kind: "error"; message: string };

type Props = {
  tree: DraftTree;
  open: boolean;
  onToggle: () => void;
  onChange: (values: DraftTree["values"]) => void;
  /** Re-read the repo and replace the tree with what is in it. */
  onPull: () => void;
  onCommit: () => void;
  pulling: boolean;
  push: PushState;
  /** No credential is configured, so neither button can work. */
  gitEnabled: boolean;
  /** A push writes the *stored* tree, so an unsaved one has nothing to push. */
  saved: boolean;
  /** How much a pull would replace — nothing to warn about when it is zero. */
  releaseCount: number;
};

/** A git URL as the name people call it: the last path segment, without `.git`. */
export const repoName = (url: string): string =>
  url.trim().replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || "not set";

export function RepoPanel({
  tree,
  open,
  onToggle,
  onChange,
  onPull,
  onCommit,
  pulling,
  push,
  gitEnabled,
  saved,
  releaseCount,
}: Props) {
  /**
   * A pull replaces what is in the tree, so the first press on a tree that
   * holds something asks. The portal's own confirm rather than
   * `window.confirm`, for the reason the Jenkinsfile preview gives: a browser
   * dialog looks like it came from somewhere else.
   */
  const [confirming, setConfirming] = useState(false);
  const connected = !!tree.values.repoUrl.trim();
  // Every reason a button cannot work, said on the button rather than found by
  // pressing it.
  const why = !gitEnabled
    ? "No git credential is configured for this portal (ARGOCD_VALUES_TOKEN)."
    : !connected
      ? "This tree has no values repository yet."
      : "";

  return (
    <div className="ag-repo-panel">
      <div className="ag-repo-bar">
        <button type="button" className="ag-repo-toggle" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span className="ag-repo-summary">
            <span className="ag-repo-role">Values</span>
            <span className="ag-repo-ref">
              {repoName(tree.values.repoUrl)}
              <span className="ag-repo-rev">@{tree.values.revision || "?"}</span>
            </span>
            {tree.values.path && <span className="ag-repo-sub">{tree.values.path}/</span>}
          </span>
        </button>

        <div className="ag-repo-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={!!why || pulling}
            title={why || "Re-read the repository and replace this tree with what is in it"}
            onClick={() => {
              if (releaseCount && !confirming) setConfirming(true);
              else {
                setConfirming(false);
                onPull();
              }
            }}
          >
            <CloudDownload size={16} aria-hidden="true" />{" "}
            {pulling ? "Pulling…" : confirming ? "Pull anyway" : "Pull"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!!why || !saved || push.kind === "busy"}
            title={why || (!saved ? "Saving — the commit writes the saved tree" : "Commit these files and open a pull request")}
            onClick={onCommit}
          >
            <GitPullRequestArrow size={16} aria-hidden="true" />{" "}
            {push.kind === "busy" ? "Committing…" : "Commit"}
          </button>
        </div>
      </div>

      {confirming && (
        <p className="ag-push-result warn">
          <TriangleAlert size={14} aria-hidden="true" /> Pulling replaces the {releaseCount} microservice
          {releaseCount === 1 ? "" : "s"} in this tree with whatever is in the repository.
        </p>
      )}

      {push.kind === "done" && (
        <p className={`ag-push-result${push.changed ? "" : " quiet"}`}>
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
            <>The repository already matches this tree — nothing to commit.</>
          )}
        </p>
      )}
      {push.kind === "error" && (
        <p className="ag-push-result error">
          <TriangleAlert size={14} aria-hidden="true" /> {push.message}
        </p>
      )}

      {open && (
        <div className="ag-repo">
          <div className="field-block">
            <span>
              Values repo URL
              <Help label="the values repository">
                <p>Where the files below are committed, and the repo the root Application watches.</p>
                <p>This is the one you push to — the chart repo above is read-only.</p>
              </Help>
            </span>
            <input
              aria-label="Values repo URL"
              value={tree.values.repoUrl}
              placeholder="https://git.example.com/gitops/microservices-values.git"
              onChange={(e) => onChange({ ...tree.values, repoUrl: e.target.value })}
              onBlur={(e) => onChange({ ...tree.values, repoUrl: normalizeRepoUrl(e.target.value) })}
            />
            {isSshUrl(tree.values.repoUrl) && (
              <small className="field-hint">SSH URL — this becomes {normalizeRepoUrl(tree.values.repoUrl)} on save.</small>
            )}
          </div>
          <label>
            <span>Branch</span>
            <input
              value={tree.values.revision}
              placeholder="main"
              onChange={(e) => onChange({ ...tree.values, revision: e.target.value })}
            />
          </label>
          <div className="field-block">
            <span>
              Subdirectory for this tree
              <Help label="the subdirectory">
                <p>At the repository root a commit only adds and updates — a removed namespace keeps its directory.</p>
                <p>
                  Point the tree at a subdirectory and removals travel too, because that directory is this tree's
                  outright.
                </p>
              </Help>
            </span>
            <input
              aria-label="Subdirectory for this tree"
              placeholder="(repo root)"
              value={tree.values.path}
              onChange={(e) => onChange({ ...tree.values, path: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

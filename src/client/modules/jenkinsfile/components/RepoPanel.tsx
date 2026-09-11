import { CloudDownload, ExternalLink, GitPullRequestArrow, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { JenkinsfilePipeline } from "../../../../server/types";

/**
 * Where this pipeline came from and where it goes back to.
 *
 * The ArgoCD module's `RepoPanel` is the same panel and the same two buttons,
 * and this is deliberately its twin rather than a second idea about what
 * connecting a repository means — one row naming the repo, Pull and Commit on
 * it, and the push result underneath with the pull request's link.
 *
 * It is smaller in one way: there is nothing to unfold. A values tree has a
 * repo URL, a branch and a subdirectory that are all worth editing later; a
 * pipeline has the one file it was read from, and re-pointing that is what
 * connecting a repository again is for.
 */

export type PushState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; branch: string; prUrl: string; changed: boolean; note?: string }
  | { kind: "error"; message: string };

type Props = {
  repo: NonNullable<JenkinsfilePipeline["repo"]>;
  /** Re-read the file and replace the pipeline with what is in it. */
  onPull: () => void;
  onCommit: () => void;
  pulling: boolean;
  push: PushState;
  /** No git credential is configured, so neither button can work. */
  gitEnabled: boolean;
  /** A push writes the *stored* pipeline, so an unsaved one has nothing to push. */
  saved: boolean;
  /** How much a pull would replace — nothing to warn about when it is zero. */
  stageCount: number;
};

/** A git URL as the name people call it: the last path segment, without `.git`. */
export const repoName = (url: string): string =>
  url.trim().replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || "not set";

export function RepoPanel({ repo, onPull, onCommit, pulling, push, gitEnabled, saved, stageCount }: Props) {
  /**
   * A pull replaces what is in the builder, so the first press on a pipeline
   * that holds something asks. The portal's own confirm rather than
   * `window.confirm`, for the reason the preview gives: a browser dialog looks
   * like it came from somewhere else.
   */
  const [confirming, setConfirming] = useState(false);
  // Every reason a button cannot work, said on the button rather than found by
  // pressing it.
  const why = !gitEnabled ? "No git credential is configured for this portal (GIT_URL / GIT_TOKEN)." : "";

  return (
    <div className="jf-repo-panel">
      <div className="jf-repo-bar">
        <span className="jf-repo-summary">
          <span className="jf-repo-role">Repo</span>
          <span className="jf-repo-ref">
            {repoName(repo.repoUrl)}
            <span className="jf-repo-rev">@{repo.revision || "?"}</span>
          </span>
          <span className="jf-repo-file">{repo.path}</span>
        </span>

        <div className="jf-repo-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={!!why || pulling}
            title={why || "Re-read the Jenkinsfile and replace this pipeline with what is in it"}
            onClick={() => {
              if (stageCount && !confirming) setConfirming(true);
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
            title={
              why || (!saved ? "Saving — the commit writes the saved pipeline" : "Commit this file and open a pull request")
            }
            onClick={onCommit}
          >
            <GitPullRequestArrow size={16} aria-hidden="true" /> {push.kind === "busy" ? "Committing…" : "Commit"}
          </button>
        </div>
      </div>

      {confirming && (
        <p className="jf-push-result warn">
          <TriangleAlert size={14} aria-hidden="true" /> Pulling replaces the {stageCount} stage
          {stageCount === 1 ? "" : "s"} in this pipeline with whatever is in the repository.
        </p>
      )}

      {push.kind === "done" && (
        <p className={`jf-push-result${push.changed ? "" : " quiet"}`}>
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
            <>The repository already matches this pipeline — nothing to commit.</>
          )}
        </p>
      )}
      {push.kind === "error" && (
        <p className="jf-push-result error">
          <TriangleAlert size={14} aria-hidden="true" /> {push.message}
        </p>
      )}
    </div>
  );
}

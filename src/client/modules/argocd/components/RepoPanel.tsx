import { exampleRepoUrl, isSshUrl, normalizeRepoUrl, repoWebUrl } from "../../../../server/gitUrl";
import { Help } from "../../../Help";
import { RepoPanel as GitRepoPanel } from "../../../RepoPanel";
import type { DraftTree } from "../document";

export { CommitButton, PushResult, repoName, type PushState } from "../../../RepoPanel";

/**
 * Where this tree comes from and where it goes back to. The values repo is the
 * panel, with Pull on the row that names it; the chart is one small line
 * underneath (`ChartLine`), because it is set once and read forever.
 */

/** Every reason git cannot be reached from this tree, said on the button rather than found by pressing it. */
export const gitBlocked = (tree: DraftTree, gitEnabled: boolean): string =>
  !gitEnabled
    ? "No git credential is configured for this portal (ARGOCD_VALUES_TOKEN)."
    : !tree.values.repoUrl.trim()
      ? "This tree has no values repository yet."
      : "";

type Props = {
  tree: DraftTree;
  onChange: (values: DraftTree["values"]) => void;
  /** Re-read the repo and replace the tree with what is in it. */
  onPull: () => void;
  pulling: boolean;
  gitEnabled: boolean;
  gitUrl: string;
  /** How much a pull would replace — nothing to warn about when it is zero. */
  releaseCount: number;
  error?: string;
};

export function RepoPanel({ tree, onChange, onPull, pulling, gitEnabled, gitUrl, releaseCount, error }: Props) {
  return (
    <GitRepoPanel
      role="Values"
      repoUrl={tree.values.repoUrl}
      revision={tree.values.revision}
      sub={tree.values.path ? `${tree.values.path}/` : ""}
      link={repoWebUrl(tree.values.repoUrl, tree.values.revision, tree.values.path)}
      blocked={gitBlocked(tree, gitEnabled)}
      error={error}
      onPull={onPull}
      pulling={pulling}
      replaces={releaseCount ? `the ${releaseCount} microservice${releaseCount === 1 ? "" : "s"} in this tree` : ""}
    >
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
          placeholder={exampleRepoUrl(gitUrl, "microservices-values")}
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
              Point the tree at a subdirectory and removals travel too, because that directory is this tree's outright.
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
    </GitRepoPanel>
  );
}

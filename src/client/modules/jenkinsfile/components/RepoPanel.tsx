import type { JenkinsfilePipeline } from "../../../../server/types";
import { exampleRepoUrl, isSshUrl, normalizeRepoUrl, repoWebUrl } from "../../../../server/gitUrl";
import { Help } from "../../../Help";
import { RepoPanel as GitRepoPanel } from "../../../RepoPanel";

/**
 * Where this pipeline came from and where it goes back to — the ArgoCD
 * module's panel with this module's three fields, so the connection can be
 * changed mid-edit the same way there as here.
 */

type Repo = NonNullable<JenkinsfilePipeline["repo"]>;

/** What an unconnected pipeline shows in the fields. */
export const EMPTY_REPO: Repo = { repoUrl: "", revision: "main", path: "" };

/** Every reason git cannot be reached from this pipeline, said on the button rather than found by pressing it. */
export const gitBlocked = (repo: Repo, gitEnabled: boolean): string =>
  !gitEnabled
    ? "No git credential is configured for this portal (GIT_URL / GIT_TOKEN, or GITHUB_TOKEN)."
    : !repo.repoUrl.trim()
      ? "This pipeline has no repository yet."
      : "";

type Props = {
  repo: Repo;
  onChange: (repo: Repo) => void;
  /** Re-read the file and replace the pipeline with what is in it. */
  onPull: () => void;
  pulling: boolean;
  gitEnabled: boolean;
  gitUrl: string;
  /** How much a pull would replace — nothing to warn about when it is zero. */
  stageCount: number;
  error?: string;
};

export function RepoPanel({ repo, onChange, onPull, pulling, gitEnabled, gitUrl, stageCount, error }: Props) {
  return (
    <GitRepoPanel
      role="Repo"
      repoUrl={repo.repoUrl}
      revision={repo.revision}
      sub={repo.path}
      link={repoWebUrl(repo.repoUrl, repo.revision, repo.path, true)}
      blocked={gitBlocked(repo, gitEnabled)}
      error={error}
      onPull={onPull}
      pulling={pulling}
      replaces={stageCount ? `the ${stageCount} stage${stageCount === 1 ? "" : "s"} in this pipeline` : ""}
    >
      <div className="field-block">
        <span>Repository URL</span>
        <input
          aria-label="Repository URL"
          value={repo.repoUrl}
          placeholder={exampleRepoUrl(gitUrl, "service")}
          onChange={(e) => onChange({ ...repo, repoUrl: e.target.value })}
          onBlur={(e) => onChange({ ...repo, repoUrl: normalizeRepoUrl(e.target.value, gitUrl) })}
        />
        {isSshUrl(repo.repoUrl) && (
          <small className="field-hint">SSH URL — this becomes {normalizeRepoUrl(repo.repoUrl, gitUrl)} on save.</small>
        )}
      </div>
      <label>
        <span>Branch</span>
        <input value={repo.revision} placeholder="main" onChange={(e) => onChange({ ...repo, revision: e.target.value })} />
      </label>
      <div className="field-block">
        <span>
          Jenkinsfile path
          <Help label="the Jenkinsfile path">
            <p>Empty finds it: a root Jenkinsfile, or the only one in the repository.</p>
            <p>With several, name the one this pipeline is — Commit writes back to that file.</p>
          </Help>
        </span>
        <input
          aria-label="Jenkinsfile path"
          placeholder="(found automatically)"
          value={repo.path}
          onChange={(e) => onChange({ ...repo, path: e.target.value })}
        />
      </div>
    </GitRepoPanel>
  );
}

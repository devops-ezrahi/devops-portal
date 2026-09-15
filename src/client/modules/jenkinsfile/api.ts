import { request } from "../../api";
import type { JenkinsfilePipeline } from "../../../server/types";

/**
 * What the server accepts. Its own id, owner, timestamps — and `name`, which it
 * mints from the author — are its business, not the builder's.
 */
export type PipelineInput = Pick<JenkinsfilePipeline, "name" | "library" | "envVars" | "stages" | "repo"> & {
  params: NonNullable<JenkinsfilePipeline["params"]>;
};

export function listPipelines() {
  // `sharedLibrary` and `gitEnabled` ride along rather than needing their own
  // endpoints — one configured string and one boolean the builder needs before
  // it can render the import field and the repository buttons.
  return request<{ pipelines: JenkinsfilePipeline[]; sharedLibrary: string; gitEnabled: boolean }>(
    "/api/jenkinsfile/pipelines"
  );
}

export function createPipeline(input: PipelineInput) {
  return request<{ pipeline: JenkinsfilePipeline }>("/api/jenkinsfile/pipelines", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updatePipeline(id: string, input: PipelineInput) {
  return request<{ pipeline: JenkinsfilePipeline }>(`/api/jenkinsfile/pipelines/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deletePipeline(id: string) {
  return request<{ ok: true }>(`/api/jenkinsfile/pipelines/${id}`, { method: "DELETE" });
}

/**
 * Read a Jenkinsfile out of a repository. `path` may be empty — the server
 * searches the clone for one and answers with the path it settled on, or with
 * a 404 whose message says why it could not.
 */
export function pullJenkinsfile(repoUrl: string, revision: string, path: string) {
  // `repoUrl` comes back because the server may have rewritten it — an SSH URL
  // is normalised to its https form before anything is cloned.
  return request<{ path: string; text: string; candidates: string[]; repoUrl: string; revision: string }>(
    "/api/jenkinsfile/pull",
    { method: "POST", body: JSON.stringify({ repoUrl, revision, path }) }
  );
}

/**
 * Commit the generated Jenkinsfile onto this pipeline's branch and open a PR.
 * The destination is the *stored* pipeline's, so a push always follows a save.
 */
export function pushPipeline(id: string, text: string, branch?: string, message?: string) {
  return request<{ branch: string; changed: boolean; prUrl: string; note?: string }>(
    `/api/jenkinsfile/pipelines/${id}/push`,
    { method: "POST", body: JSON.stringify({ text, branch, message }) }
  );
}

/** One suggestion in the `image` picker: the name, and its labels as one line. */
export type PickableImage = { name: string; info: string };

/** Image names for the `image` picker, with their SCREAMING_CASE labels. */
export function getImages() {
  return request<{ images: PickableImage[] }>("/api/jenkinsfile/images");
}

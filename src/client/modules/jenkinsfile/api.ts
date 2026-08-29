import { request } from "../../api";
import type { JenkinsfilePipeline } from "../../../server/types";

/**
 * What the server accepts. Its own id, owner, timestamps — and `name`, which it
 * mints from the author — are its business, not the builder's.
 */
export type PipelineInput = Pick<JenkinsfilePipeline, "name" | "library" | "envVars" | "stages"> & {
  params: NonNullable<JenkinsfilePipeline["params"]>;
};

export function listPipelines() {
  // `sharedLibrary` rides along rather than needing its own endpoint — it is one
  // configured string the builder needs before it can render the import field.
  return request<{ pipelines: JenkinsfilePipeline[]; sharedLibrary: string }>("/api/jenkinsfile/pipelines");
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

/** One suggestion in the `image` picker: the name, and its labels as one line. */
export type PickableImage = { name: string; info: string };

/** Image names for the `image` picker, with their SCREAMING_CASE labels. */
export function getImages() {
  return request<{ images: PickableImage[] }>("/api/jenkinsfile/images");
}

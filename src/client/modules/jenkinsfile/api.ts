import { request } from "../../api";
import type { JenkinsfilePipeline } from "../../../server/types";

/** What the server accepts — the record's own id, owner and timestamps are its business. */
export type PipelineInput = Pick<JenkinsfilePipeline, "name" | "library" | "envVars" | "stages">;

export function listPipelines() {
  return request<{ pipelines: JenkinsfilePipeline[] }>("/api/jenkinsfile/pipelines");
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

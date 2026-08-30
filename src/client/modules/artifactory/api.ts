import { request } from "../../api";
import type { ArtifactoryJob, ArtifactoryScenario, UrlCopyInput } from "../../../server/types";

export type FileEntry = { file: File; path: string };

export function submitUrlCopy(input: UrlCopyInput) {
  return request<{ job: ArtifactoryJob }>("/api/artifactory/jobs/url-copy", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * A folder upload is three calls, not one. The archive is sent in parts *while*
 * it is still being zipped — the two used to run one after the other, so the
 * user waited for the sum of them, and the whole archive had to exist in the
 * tab before a single byte moved.
 *
 * A `ReadableStream` request body would express this in one call, but it is
 * Chrome-only and needs HTTP/2, which `npm run dev` does not serve.
 */
export function beginFolderUpload() {
  return request<{ uploadId: string }>("/api/artifactory/uploads", { method: "POST" });
}

/** `offset` is where the client believes the server's file ends; a mismatch is a 409. */
export function uploadArchivePart(uploadId: string, offset: number, part: Blob) {
  return request<{ bytes: number }>(`/api/artifactory/uploads/${uploadId}?offset=${offset}`, {
    method: "PUT",
    body: part,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

export function completeFolderUpload(input: {
  uploadId: string;
  folderName: string;
  fileCount: number;
  totalBytes: number;
}) {
  return request<{ job: ArtifactoryJob }>("/api/artifactory/jobs/folder-upload", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listJobs() {
  return request<{ jobs: ArtifactoryJob[] }>("/api/artifactory/jobs");
}

export function getJob(id: string) {
  return request<{ job: ArtifactoryJob }>(`/api/artifactory/jobs/${id}`);
}

export function cancelJob(id: string) {
  return request<{ job: ArtifactoryJob }>(`/api/artifactory/jobs/${id}/cancel`, { method: "POST" });
}

/** Dev only — the server route exists only when SSO is off. */
export function simulateJob(scenario: ArtifactoryScenario) {
  return request<{ job: ArtifactoryJob }>("/api/artifactory/jobs/simulate", {
    method: "POST",
    body: JSON.stringify({ scenario }),
  });
}

import { request, requestFormData } from "../../api";
import type { ArtifactoryJob, UrlCopyInput } from "../../../server/types";

export type FileEntry = { file: File; path: string };

export function submitUrlCopy(input: UrlCopyInput) {
  return request<{ job: ArtifactoryJob }>("/api/artifactory/jobs/url-copy", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function submitFolderUpload(folderName: string, entries: FileEntry[]) {
  const formData = new FormData();
  formData.append("folderName", folderName);

  for (const { file, path } of entries) {
    // Third arg sets the filename in the multipart part — server reads it as originalname
    formData.append("files", file, path);
  }

  return requestFormData<{ job: ArtifactoryJob }>("/api/artifactory/jobs/folder-upload", formData);
}

export function listJobs() {
  return request<{ jobs: ArtifactoryJob[] }>("/api/artifactory/jobs");
}

export function getJob(id: string) {
  return request<{ job: ArtifactoryJob }>(`/api/artifactory/jobs/${id}`);
}

import { ForbiddenError, UnauthenticatedError, request } from "../../api";
import type { ArtifactoryJob, UrlCopyInput } from "../../../server/types";

export type FileEntry = { file: File; path: string };

export function submitUrlCopy(input: UrlCopyInput) {
  return request<{ job: ArtifactoryJob }>("/api/artifactory/jobs/url-copy", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * XHR rather than the shared `requestFormData`: a node_modules upload is hundreds
 * of MB and `fetch` cannot report upload progress at all. Same error mapping as
 * the shared helper.
 */
export function submitFolderUpload(
  folderName: string,
  entries: FileEntry[],
  onProgress: (percent: number) => void = () => {}
): Promise<{ job: ArtifactoryJob }> {
  const formData = new FormData();
  formData.append("folderName", folderName);

  for (const { file, path } of entries) {
    // Third arg sets the filename in the multipart part — server reads it as originalname
    formData.append("files", file, path);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/artifactory/jobs/folder-upload");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      let body: { job?: ArtifactoryJob; error?: string; ssoUrl?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error page; fall through to the status-based message.
      }
      if (xhr.status === 401) return reject(new UnauthenticatedError(body.ssoUrl ?? ""));
      if (xhr.status === 403) return reject(new ForbiddenError(body.error ?? "Access denied"));
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error(body.error ?? `Request failed: ${xhr.status}`));
      }
      resolve(body as { job: ArtifactoryJob });
    };

    xhr.onerror = () => reject(new Error("Upload failed — the connection dropped"));
    xhr.send(formData);
  });
}

export function listJobs() {
  return request<{ jobs: ArtifactoryJob[] }>("/api/artifactory/jobs");
}

export function getJob(id: string) {
  return request<{ job: ArtifactoryJob }>(`/api/artifactory/jobs/${id}`);
}

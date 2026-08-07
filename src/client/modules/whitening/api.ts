import { request, requestFormData } from "../../api";
import type { WhiteningJob, WhiteningScenario } from "../../../server/types";

export function submitUnpack(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return requestFormData<{ job: WhiteningJob }>("/api/whitening/jobs", formData);
}

export function listJobs() {
  return request<{ jobs: WhiteningJob[] }>("/api/whitening/jobs");
}

export function getJob(id: string) {
  return request<{ job: WhiteningJob }>(`/api/whitening/jobs/${id}`);
}

export function cancelJob(id: string) {
  return request<{ job: WhiteningJob }>(`/api/whitening/jobs/${id}/cancel`, { method: "POST" });
}

/** Dev only — the server route exists only when SSO is off. */
export function simulateJob(scenario: WhiteningScenario) {
  return request<{ job: WhiteningJob }>("/api/whitening/jobs/simulate", {
    method: "POST",
    body: JSON.stringify({ scenario }),
  });
}

import type { ResearchJob } from "../../../server/types";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchProjects(): Promise<string[]> {
  const body = await requestJson<{ projects: string[] }>("/api/research/projects");
  return body.projects;
}

export async function fetchJobs(): Promise<ResearchJob[]> {
  const body = await requestJson<{ jobs: ResearchJob[] }>("/api/research/jobs");
  return body.jobs;
}

export async function submitQuestion(project: string, question: string): Promise<ResearchJob> {
  const body = await requestJson<{ job: ResearchJob }>("/api/research/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, question }),
  });
  return body.job;
}

export async function pollJob(jobId: string): Promise<ResearchJob> {
  const body = await requestJson<{ job: ResearchJob }>(`/api/research/jobs/${jobId}`);
  return body.job;
}

export async function cancelJob(jobId: string): Promise<ResearchJob> {
  const body = await requestJson<{ job: ResearchJob }>(`/api/research/jobs/${jobId}/cancel`, { method: "POST" });
  return body.job;
}

import type { ResearchCategory, ResearchConversation, ResearchJob } from "../../../server/types";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchCategories(): Promise<ResearchCategory[]> {
  const body = await requestJson<{ categories: ResearchCategory[] }>("/api/research/categories");
  return body.categories;
}

export async function fetchConversations(): Promise<ResearchConversation[]> {
  const body = await requestJson<{ conversations: ResearchConversation[] }>("/api/research/conversations");
  return body.conversations;
}

export async function createConversation(project: string | null): Promise<ResearchConversation> {
  const body = await requestJson<{ conversation: ResearchConversation }>("/api/research/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
  return body.conversation;
}

export async function fetchConversationJobs(conversationId: string): Promise<ResearchJob[]> {
  const body = await requestJson<{ jobs: ResearchJob[] }>(`/api/research/conversations/${conversationId}/jobs`);
  return body.jobs;
}

export async function submitQuestion(conversationId: string, question: string): Promise<ResearchJob> {
  const body = await requestJson<{ job: ResearchJob }>(`/api/research/conversations/${conversationId}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
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

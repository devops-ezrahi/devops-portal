import type { AiCategory, AiConversation, AiJob } from "../../../server/types";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchCategories(): Promise<AiCategory[]> {
  const body = await requestJson<{ categories: AiCategory[] }>("/api/ai/categories");
  return body.categories;
}

export async function fetchConversations(): Promise<AiConversation[]> {
  const body = await requestJson<{ conversations: AiConversation[] }>("/api/ai/conversations");
  return body.conversations;
}

export async function createConversation(project: string | null): Promise<AiConversation> {
  const body = await requestJson<{ conversation: AiConversation }>("/api/ai/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
  return body.conversation;
}

export async function fetchConversationJobs(conversationId: string): Promise<AiJob[]> {
  const body = await requestJson<{ jobs: AiJob[] }>(`/api/ai/conversations/${conversationId}/jobs`);
  return body.jobs;
}

export async function submitQuestion(conversationId: string, question: string): Promise<AiJob> {
  const body = await requestJson<{ job: AiJob }>(`/api/ai/conversations/${conversationId}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return body.job;
}

export async function pollJob(jobId: string): Promise<AiJob> {
  const body = await requestJson<{ job: AiJob }>(`/api/ai/jobs/${jobId}`);
  return body.job;
}

export async function cancelJob(jobId: string): Promise<AiJob> {
  const body = await requestJson<{ job: AiJob }>(`/api/ai/jobs/${jobId}/cancel`, { method: "POST" });
  return body.job;
}

import { describe, expect, it } from "vitest";
import { sweepConversations } from "./sweepConversations";
import type { AiConversation, AiJob } from "../../types";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const HOUR = 3_600_000;
const ARCHIVE = 4 * HOUR;
const DELETE = 48 * HOUR;

function chat(id: string, idleHours: number, extra: Partial<AiConversation> = {}): AiConversation {
  const at = new Date(NOW - idleHours * HOUR).toISOString();
  return {
    id,
    title: `chat ${id}`,
    project: "devops-portal",
    submittedBy: "u1",
    submittedByName: "User One",
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function job(id: string, conversationId: string, status: AiJob["status"] = "completed"): AiJob {
  const at = new Date(NOW).toISOString();
  return {
    id,
    conversationId,
    status,
    submittedBy: "u1",
    submittedByName: "User One",
    createdAt: at,
    updatedAt: at,
    project: "devops-portal",
    question: "why?",
    log: [],
  };
}

function sweep(conversations: AiConversation[], jobs: AiJob[]) {
  const cMap = new Map(conversations.map((c) => [c.id, c]));
  const jMap = new Map(jobs.map((j) => [j.id, j]));
  const counts = sweepConversations(cMap, jMap, ARCHIVE, DELETE, NOW);
  return { counts, conversations: cMap, jobs: jMap };
}

describe("sweepConversations", () => {
  it("leaves a fresh chat alone", () => {
    const { counts, conversations } = sweep([chat("CONV-0001", 1)], [job("RES-0001", "CONV-0001")]);
    expect(counts).toEqual({ archived: 0, deleted: 0 });
    expect(conversations.get("CONV-0001")?.archivedAt).toBeUndefined();
  });

  it("archives a chat idle past the archive threshold", () => {
    const { counts, conversations } = sweep([chat("CONV-0001", 5)], []);
    expect(counts).toEqual({ archived: 1, deleted: 0 });
    expect(conversations.get("CONV-0001")?.archivedAt).toBe(new Date(NOW).toISOString());
  });

  it("does not move updatedAt when archiving, so the chat still ages into deletion", () => {
    const before = chat("CONV-0001", 5);
    const { conversations } = sweep([before], []);
    expect(conversations.get("CONV-0001")?.updatedAt).toBe(before.updatedAt);
  });

  it("deletes a chat idle past the delete threshold, along with its jobs", () => {
    const { counts, conversations, jobs } = sweep(
      [chat("CONV-0001", 49), chat("CONV-0002", 1)],
      [job("RES-0001", "CONV-0001"), job("RES-0002", "CONV-0001"), job("RES-0003", "CONV-0002")]
    );
    expect(counts).toEqual({ archived: 0, deleted: 1 });
    expect([...conversations.keys()]).toEqual(["CONV-0002"]);
    expect([...jobs.keys()]).toEqual(["RES-0003"]);
  });

  it("never touches a chat with a job still running, however old its timestamp", () => {
    const { counts, conversations, jobs } = sweep(
      [chat("CONV-0001", 100)],
      [job("RES-0001", "CONV-0001", "in-progress")]
    );
    expect(counts).toEqual({ archived: 0, deleted: 0 });
    expect(conversations.get("CONV-0001")?.archivedAt).toBeUndefined();
    expect(jobs.size).toBe(1);
  });

  // Un-archiving is submitQuestion's job, not this sweep's — which is the only
  // reason a chat archived by hand from the UI survives at all: it was just
  // used, so every clock here says it is nowhere near idle.
  it("leaves a freshly archived chat alone instead of un-archiving it", () => {
    const archivedAt = "2026-08-19T00:00:00.000Z";
    const { counts, conversations } = sweep([chat("CONV-0001", 0, { archivedAt })], []);
    expect(counts).toEqual({ archived: 0, deleted: 0 });
    expect(conversations.get("CONV-0001")?.archivedAt).toBe(archivedAt);
  });

  it("archives once, not once per sweep", () => {
    const c = chat("CONV-0001", 5);
    const cMap = new Map([[c.id, c]]);
    const jMap = new Map<string, AiJob>();
    sweepConversations(cMap, jMap, ARCHIVE, DELETE, NOW);
    expect(sweepConversations(cMap, jMap, ARCHIVE, DELETE, NOW)).toEqual({ archived: 0, deleted: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { sweepConversations } from "./sweepConversations";
import type { AiConversation, AiJob } from "../../types";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const HOUR = 3_600_000;
const ARCHIVE = 4 * HOUR;

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
  const result = sweepConversations(cMap, jobs, ARCHIVE, NOW);
  return { result, conversations: cMap };
}

describe("sweepConversations", () => {
  it("leaves a fresh chat alone", () => {
    const { result, conversations } = sweep([chat("CONV-0001", 1)], [job("RES-0001", "CONV-0001")]);
    expect(result).toEqual({ archived: [] });
    expect(conversations.get("CONV-0001")?.archivedAt).toBeUndefined();
  });

  it("archives a chat idle past the archive threshold", () => {
    const { result, conversations } = sweep([chat("CONV-0001", 5)], []);
    expect(result).toEqual({ archived: ["CONV-0001"] });
    expect(conversations.get("CONV-0001")?.archivedAt).toBe(new Date(NOW).toISOString());
  });

  // The caller persists whatever ids come back, so returning them rather than a
  // count is the whole contract — a miscount would silently lose the write.
  it("names every chat it archived", () => {
    const { result } = sweep([chat("CONV-0001", 5), chat("CONV-0002", 9), chat("CONV-0003", 1)], []);
    expect(result.archived).toEqual(["CONV-0001", "CONV-0002"]);
  });

  it("does not move updatedAt when archiving — that is what the client sorts by", () => {
    const before = chat("CONV-0001", 5);
    const { conversations } = sweep([before], []);
    expect(conversations.get("CONV-0001")?.updatedAt).toBe(before.updatedAt);
  });

  it("never touches a chat with a job still running, however old its timestamp", () => {
    const { result, conversations } = sweep([chat("CONV-0001", 100)], [job("RES-0001", "CONV-0001", "in-progress")]);
    expect(result).toEqual({ archived: [] });
    expect(conversations.get("CONV-0001")?.archivedAt).toBeUndefined();
  });

  // Un-archiving is submitQuestion's job, not this sweep's — which is the only
  // reason a chat archived by hand from the UI survives at all: it was just
  // used, so every clock here says it is nowhere near idle.
  it("leaves a freshly archived chat alone instead of un-archiving it", () => {
    const archivedAt = "2026-08-19T00:00:00.000Z";
    const { result, conversations } = sweep([chat("CONV-0001", 0, { archivedAt })], []);
    expect(result).toEqual({ archived: [] });
    expect(conversations.get("CONV-0001")?.archivedAt).toBe(archivedAt);
  });

  it("archives once, not once per sweep", () => {
    const c = chat("CONV-0001", 5);
    const cMap = new Map([[c.id, c]]);
    sweepConversations(cMap, [], ARCHIVE, NOW);
    expect(sweepConversations(cMap, [], ARCHIVE, NOW)).toEqual({ archived: [] });
  });

  // Nothing is deleted any more: jobs live on the volume, so an ancient chat is
  // archived and then left exactly where it is.
  it("keeps an ancient chat instead of deleting it", () => {
    const { result, conversations } = sweep([chat("CONV-0001", 500)], []);
    expect(result.archived).toEqual(["CONV-0001"]);
    expect(conversations.has("CONV-0001")).toBe(true);
  });
});

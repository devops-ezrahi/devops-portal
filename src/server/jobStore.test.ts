import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { JobStore } from "./jobStore";

type TestJob = {
  id: string;
  status: string;
  updatedAt: string;
  errorMessage?: string;
  log: string[];
};

function newDir() {
  return mkdtempSync(join(tmpdir(), "jobstore-test-"));
}

function newJob(id: string, status = "pending"): TestJob {
  return { id, status, updatedAt: new Date().toISOString(), log: [] };
}

describe("JobStore", () => {
  it("keeps a running job in memory and serves it whole", async () => {
    const store = new JobStore<TestJob>(newDir(), "ART");
    const job = newJob(store.nextId(), "in-progress");
    store.add(job);

    expect(job.id).toBe("ART-0001");
    // The synchronous get is the mutation path every module's patch/appendLog uses.
    expect(store.get(job.id)).toBe(job);
    job.log.push("cloning ...");
    expect((await store.read(job.id))?.log).toEqual(["cloning ..."]);
    // A running job shows in the list by reference, log and all.
    expect(store.all()[0]).toBe(job);
  });

  it("drops a settled job from memory but keeps its log on disk", async () => {
    const dir = newDir();
    const store = new JobStore<TestJob>(dir, "ART");
    const job = newJob(store.nextId(), "in-progress");
    store.add(job);
    job.log.push("line one", "line two");
    job.status = "completed";
    await store.settle(job.id);

    // Gone from the live map — this is the "clear it from memory" half.
    expect(store.get(job.id)).toBeUndefined();
    // The list serves a log-free summary ...
    expect(store.all()).toEqual([{ ...job, log: [] }]);
    // ... and the full log is still readable from the volume.
    expect((await store.read(job.id))?.log).toEqual(["line one", "line two"]);
    expect(JSON.parse(readFileSync(join(dir, "ART-0001.json"), "utf8")).log).toHaveLength(2);
  });

  it("rehydrates history and resumes ids past the highest on disk", async () => {
    const dir = newDir();
    const first = new JobStore<TestJob>(dir, "ART");
    for (const status of ["completed", "failed"]) {
      const job = newJob(first.nextId(), "in-progress");
      first.add(job);
      job.log.push(`log for ${job.id}`);
      job.status = status;
      await first.settle(job.id);
    }

    const second = new JobStore<TestJob>(dir, "ART");
    expect(second.all().map((j) => j.id)).toEqual(["ART-0001", "ART-0002"]);
    // Summaries only — the logs stay on disk until someone opens a job.
    expect(second.all().every((j) => j.log.length === 0)).toBe(true);
    expect((await second.read("ART-0002"))?.log).toEqual(["log for ART-0002"]);
    expect(second.nextId()).toBe("ART-0003");
  });

  it("fails a job left running by a restart instead of leaving it pending forever", async () => {
    const dir = newDir();
    const store = new JobStore<TestJob>(dir, "ART");
    await store.add(newJob(store.nextId(), "in-progress"));

    const reopened = new JobStore<TestJob>(dir, "ART");
    const job = await reopened.read("ART-0001");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toBe("Interrupted by a server restart");
    // The correction is on disk, not just in this process.
    expect(JSON.parse(readFileSync(join(dir, "ART-0001.json"), "utf8")).status).toBe("failed");
  });

  it("skips an unreadable file rather than failing to boot", () => {
    const dir = newDir();
    writeFileSync(join(dir, "ART-0009.json"), "{ not json");
    const store = new JobStore<TestJob>(dir, "ART");
    expect(store.all()).toEqual([]);
    // The bad file still claims its id, so a fresh job cannot collide with it.
    expect(store.nextId()).toBe("ART-0001");
  });

  it("returns null for an id it has never seen", async () => {
    const store = new JobStore<TestJob>(newDir(), "ART");
    expect(await store.read("ART-4242")).toBeNull();
  });
});

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Test buttons must never reach a deployment. The routers read the gate at
 * mount time, so each case needs its own module registry.
 */
async function appWithSso(ssoRequired: boolean) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("./config")>("./config");
  // Its own volume per app: these cases assert an empty portal and ART-0001,
  // both of which the persistent job store would otherwise carry over.
  const dataDir = mkdtempSync(join(tmpdir(), "portal-sim-test-"));
  vi.doMock("./config", () => ({ config: { ...actual.config, ssoRequired, dataDir } }));

  const { createApp } = await import("./app");
  return createApp();
}

const headers = { "x-user-id": "u-alex", "x-user-groups": "portal-admins" };

afterEach(() => {
  vi.doUnmock("./config");
  vi.resetModules();
});

describe("dev simulation routes", () => {
  it("start empty — no job is ever seeded", async () => {
    for (const ssoRequired of [false, true]) {
      const app = await appWithSso(ssoRequired);
      const artifactory = await request(app).get("/api/artifactory/jobs").set(headers).expect(200);
      const whitening = await request(app).get("/api/whitening/jobs").set(headers).expect(200);
      expect(artifactory.body.jobs).toEqual([]);
      expect(whitening.body.jobs).toEqual([]);
    }
  });

  it("run a scripted job when no SSO proxy is in front", async () => {
    const app = await appWithSso(false);
    const artifactory = await request(app).post("/api/artifactory/jobs/simulate").set(headers).expect(201);
    const whitening = await request(app).post("/api/whitening/jobs/simulate").set(headers).expect(201);
    expect(artifactory.body.job.id).toBe("ART-0001");
    expect(whitening.body.job.id).toBe("WHT-0001");
    expect(artifactory.body.job.submittedBy).toBe("u-alex");
  });

  it("do not exist once SSO is required", async () => {
    const app = await appWithSso(true);
    await request(app).post("/api/artifactory/jobs/simulate").set(headers).expect(404);
    await request(app).post("/api/whitening/jobs/simulate").set(headers).expect(404);
  });
});
